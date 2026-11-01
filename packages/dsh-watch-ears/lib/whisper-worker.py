# Resident local Whisper worker.
#
# Model load costs ~4.3s on CUDA, which is far too much per utterance, so this
# process loads once and then answers one JSON request per line. It speaks the
# same shape the cloud path returns ({ text }), so callers cannot tell which
# backend answered.
import sys, os, json, time, glob

# Force UTF-8 on stdout.
#
# On Windows, Python writing to a PIPE defaults to the locale encoding (cp936 /
# GBK here), while the Node side decodes stdout as UTF-8. Chinese text then
# arrives as mojibake - the whole transcript was garbled even though the model
# read it correctly. The Node side also sets PYTHONIOENCODING, but this line is
# what makes the worker correct when run by hand or by an older manager.
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# Where the whisper checkpoints live.
#
# There is no universal location: a checkpoint cache is wherever the user put it
# (a HuggingFace hub cache, a portable install, a removable drive). Only the
# environment is trusted, and a missing directory is reported as such instead of
# being mistaken for a broken config.
MODEL_ROOTS = [
    os.environ.get('DSH_WHISPER_MODELS') or '',
]

# Standard caches, so the common case needs no environment at all: pip install
# faster-whisper + let it download once, and the checkpoint lands in the
# HuggingFace cache under the user's home. Checking these after the explicit
# setting means "I pointed it somewhere" always wins over a lucky default.
for _root in (
    os.path.join(os.path.expanduser('~'), '.cache', 'huggingface', 'hub'),
    os.path.join(os.environ.get('HF_HOME') or '', 'hub') if os.environ.get('HF_HOME') else '',
):
    if _root and os.path.isdir(_root):
        MODEL_ROOTS.append(_root)

MODELS = next((p for p in MODEL_ROOTS if p and os.path.isdir(p)), '')

def resolve(kind):
    if kind == 'ja':
        p = os.path.join(MODELS, 'models--TransWithAI--whisper-ja-1.5B-ct2')
    else:
        p = os.path.join(MODELS, 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo')
    snaps = sorted(glob.glob(os.path.join(p, 'snapshots', '*')))
    return snaps[-1] if snaps else None

def emit(obj):
    # Write UTF-8 bytes directly.
    #
    # sys.stdout.reconfigure alone was not enough here: the process is started by
    # Node from a GBK console and some Python builds keep the old encoder. Writing
    # the bytes ourselves removes the guesswork - the reader is UTF-8 by contract.
    data = (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    kind = os.environ.get('WHISPER_MODEL', 'large')
    model_dir = resolve(kind)
    if not model_dir:
        emit({'ready': False, 'error': 'model not found: ' + kind})
        return
    from faster_whisper import WhisperModel

    # CUDA is the fast path, but whether it works is a property of the MACHINE,
    # not of this code: ctranslate2 is built against CUDA 12 (cu128 in this
    # FineSub build), and an older display driver refuses it with
    # "CUDA driver version is insufficient for CUDA runtime version"
    # (measured 2026-10-29 on driver 512.89 = CUDA 11.6). Dying there used to
    # mean the whole listening chain reported "whisper worker did not become
    # ready" - i.e. a stale driver looked exactly like a missing model.
    #
    # So: try CUDA, and fall back to CPU int8 when the driver cannot take it.
    # CPU costs ~10s to load and is slower per utterance, but a slow transcript
    # beats no transcript, and the ears stay usable until the driver is updated.
    #
    # int8_float16 BEFORE float16 on purpose (measured 2026-10-30, GTX 1650):
    #   float16       warm 6.35s
    #   int8_float16  warm 1.99s
    # 3.2x, and accuracy on the reference clip came out identical. A GTX 1650
    # has no tensor cores, so fp16 matmul goes through a slow emulated path;
    # quantising the weights to int8 and only keeping fp16 accumulation is the
    # supported fast route on this card. On newer GPUs fp16 would win, so the
    # order is a decision about THIS machine, not about faster-whisper.
    attempts = [
        ('cuda', 'int8_float16'),
        ('cuda', 'float16'),
        ('cpu', 'int8'),
    ]
    model = None
    device = None
    lastError = None
    for dev, compute in attempts:
        try:
            t0 = time.time()
            model = WhisperModel(model_dir, device=dev, compute_type=compute)
            load_ms = int((time.time() - t0) * 1000)
            device = dev
            break
        except Exception as e:
            lastError = '%s/%s: %s' % (dev, compute, str(e)[:160])
    if model is None:
        emit({'ready': False, 'error': 'no backend worked: ' + lastError})
        return
    out = {'ready': True, 'loadMs': load_ms, 'device': device, 'model': os.path.basename(model_dir)}
    if device != 'cuda':
        out['fallback'] = lastError
    emit(out)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == 'QUIT':
            break
        try:
            req = json.loads(line)
        except Exception:
            emit({'error': 'bad json'})
            continue
        wav = req.get('wav')
        lang = req.get('language') or 'zh'
        # The caller decides whether the no-VAD retry is worth it: it knows the
        # segment's peak level and how long the speaker actually talked.
        fallback_ok = req.get('fallbackVad', True) is not False
        hallucinations_dropped = False
        if not wav or not os.path.exists(wav):
            emit({'error': 'no such file'})
            continue
        t1 = time.time()
        try:
            # VAD first, then plain decode if VAD heard nothing.
            #
            # vad_filter is worth having: on a long clip it drops the silence
            # around speech, which stops the decoder padding and hallucinating.
            # But it is tuned for normal level audio, and a quiet speaker near
            # the floor gets filtered out ENTIRELY - measured 2026-11-01 on two
            # real captures (peak 0.008-0.015): vad_filter=True returned '' while
            # the same clip without it returned actual speech. An empty string is
            # not "no speech", it is "I found no speech regions", and treating
            # those as the same thing is how a person talks and the companion
            # hears nothing.
            #
            # So: run VAD, and if it produced nothing, decode again without it.
            # The cost of the second pass only lands on clips that VAD dropped.
            segs, info = model.transcribe(wav, language=lang, vad_filter=True, beam_size=1,
                                           condition_on_previous_text=False)
            text = ''.join(s.text for s in segs).strip()
            used_vad = True
            if not text and fallback_ok:
                # No speech regions found. Decode again without VAD - a quiet
                # speaker legitimately falls under the VAD's level threshold.
                #
                # But skipping VAD hands the decoder straight room tone, and
                # Whisper happily invents a sentence for silence. Measured
                # 2026-11-01: seven near-identical lines ("屏幕志愿者 某某") from
                # twelve seconds of a quiet room. So a segment survives only if
                # the MODEL says it is speech: no_speech_prob is the decoder's own
                # opinion, and it is right far more often than a level threshold.
                segs2, info2 = model.transcribe(wav, language=lang, vad_filter=False, beam_size=1,
                                                condition_on_previous_text=False)
                kept = []
                for s in segs2:
                    prob = getattr(s, 'no_speech_prob', 0) or 0
                    # Whisper's own confidence that these tokens are speech.
                    # Measured on a quiet room: no_speech_prob came back >0.9
                    # while the text looked like a plausible sentence, which is
                    # exactly the trap - the model is confident the CONTENT is
                    # not speech even though the CONTENT is fluent. Meanwhile
                    # real quiet speech sits in the 0.1-0.4 range.
                    if prob > 0.75:
                        continue
                    kept.append((s.text or '').strip())
                text = ''.join(kept).strip()
                # Compressed-token guard: a hallucination repeats a tiny unit
                # ("1 2 3 4 5", "面前面前面前", subtitle credit lines). A real
                # sentence is varied. Reject when very few distinct characters
                # make up the whole line.
                if text:
                    sina = ''.join(text.split())
                    # Distinct characters per character. A real Chinese sentence
                    # runs 0.5-0.9 (26 chars in "今天他终于把这件事做完了" are ~18
                    # distinct); the repeated-token hallucination measured 6/26 =
                    # 0.23. Below a quarter, it is a loop, not a sentence.
                    if len(sina) >= 6 and len(set(sina)) / len(sina) < 0.25:
                        text = ''
                used_vad = False
                info = info2
                if not text:
                    hallucinations_dropped = True
            ms = int((time.time() - t1) * 1000)
            out = {'text': text, 'ms': ms, 'duration': round(info.duration, 2), 'vad': used_vad}
            if hallucinations_dropped:
                out['hallucinationFiltered'] = True
            if not text:
                out['empty'] = True
            emit(out)
        except Exception as e:
            emit({'error': str(e)[:200]})

main()
