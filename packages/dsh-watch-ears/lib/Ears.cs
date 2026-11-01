// dsh-watch-ears capture core.
// Two sources matter: the system loopback (what the video is playing) and the
// microphone (what the user is saying).
//
// Recording and transcoding are deliberately two passes. Pulling a resampler
// in real time from the capture event starved and wrote hundreds of megabytes
// of silence; recording the device format first and resampling the finished
// file is bounded, fast and predictable.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

public class EarsResult
{
    public bool SilenceCut;
    public int SpeechMs;
    public double NoiseFloor;
    public double EffectiveThreshold;
    public string Source;
    public string Path;
    public string Format;
    public int Bytes;
    public int Milliseconds;
    public double Peak;
    public double Rms;
}

public static class Ears
{
    public static EarsResult RecordSegment(string source, double seconds, string outPath, int sampleRate)
    {
        return RecordSegment(source, seconds, outPath, sampleRate, 0, 0);
    }

    // silenceMs > 0 turns on endpointing: the segment ends once speech has been
    // heard and then silenceMs of quiet follow it, instead of always running the
    // full window. A fixed window makes a two second sentence wait three more
    // seconds before anything can react to it, which is exactly what turns a
    // "call" into a walkie-talkie.
    public static EarsResult RecordSegment(string source, double seconds, string outPath, int sampleRate, double silenceMs, double speechThreshold)
    {
        EarsResult res = new EarsResult();
        res.Source = source;
        res.Path = outPath;
        IWaveIn capture = source == "loop"
            ? (IWaveIn)new WasapiLoopbackCapture()
            : (IWaveIn)new NAudio.CoreAudioApi.WasapiCapture();
        res.Format = capture.WaveFormat.ToString();
        string tmp = outPath + ".native.wav";
        Stopwatch sw = Stopwatch.StartNew();
        bool speechSeen = false;
        double lastLoudMs = 0;
        double firstLoudMs = 0;
        double noiseFloor = 0.02;
        bool floorInit = false;
        double effectiveThreshold = 0;
        try
        {
            using (WaveFileWriter writer = new WaveFileWriter(tmp, capture.WaveFormat))
            {
                object gate = new object();
                bool isFloat = capture.WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat;
                EventHandler<WaveInEventArgs> handler = delegate(object s, WaveInEventArgs a)
                {
                    double peak = 0;
                    if (isFloat)
                    {
                        int n = a.BytesRecorded / 4;
                        for (int k = 0; k < n; k++)
                        {
                            float f = BitConverter.ToSingle(a.Buffer, k * 4);
                            double v = f < 0 ? -(double)f : (double)f;
                            if (v > peak) peak = v;
                        }
                    }
                    else
                    {
                        int n = a.BytesRecorded / 2;
                        for (int k = 0; k < n; k++)
                        {
                            short sh = BitConverter.ToInt16(a.Buffer, k * 2);
                            double v = (sh < 0 ? -(double)sh : (double)sh) / 32768.0;
                            if (v > peak) peak = v;
                        }
                    }
                    lock (gate)
                    {
                        writer.Write(a.Buffer, 0, a.BytesRecorded);
                        // Adaptive floor. A fixed threshold is worthless here: the
                        // same speaker measured 0.035-0.085 on one take and 0.0195
                        // on the next (different distance, different room). Track
                        // the noise floor and call anything well above it speech.
                        if (!floorInit) { noiseFloor = peak; floorInit = true; }
                        else if (peak < noiseFloor) noiseFloor = peak * 0.7 + noiseFloor * 0.3;
                        else noiseFloor = noiseFloor * 0.999 + peak * 0.001;
                        double thr = Math.Max(speechThreshold > 0 ? speechThreshold * 0.4 : 0.006, noiseFloor * 2.5);
                        effectiveThreshold = thr;
                        if (peak >= thr)
                        {
                            if (!speechSeen) { speechSeen = true; firstLoudMs = sw.Elapsed.TotalMilliseconds; }
                            lastLoudMs = sw.Elapsed.TotalMilliseconds;
                        }
                    }
                };
                capture.DataAvailable += handler;
                capture.StartRecording();
                while (sw.Elapsed.TotalSeconds < seconds)
                {
                    Thread.Sleep(40);
                    if (silenceMs > 0 && speechSeen && (sw.Elapsed.TotalMilliseconds - lastLoudMs) >= silenceMs) break;
                }
                capture.StopRecording();
                capture.DataAvailable -= handler;
                Thread.Sleep(150);
                res.SilenceCut = silenceMs > 0 && speechSeen;
                res.SpeechMs = speechSeen ? (int)(lastLoudMs - firstLoudMs) : 0;
                res.NoiseFloor = noiseFloor;
                res.EffectiveThreshold = effectiveThreshold;
            }

            using (AudioFileReader reader = new AudioFileReader(tmp))
            {
                ISampleProvider sp = reader;
                if (sp.WaveFormat.Channels > 1)
                {
                    StereoToMonoSampleProvider mono = new StereoToMonoSampleProvider(sp);
                    mono.LeftVolume = 0.5f;
                    mono.RightVolume = 0.5f;
                    sp = mono;
                }
                ISampleProvider chain = sp.WaveFormat.SampleRate == sampleRate
                    ? sp
                    : new WdlResamplingSampleProvider(sp, sampleRate);
                float[] buf = new float[4096];
                double sum = 0.0;
                long n = 0;
                double peak = 0.0;
                using (WaveFileWriter outW = new WaveFileWriter(outPath, new WaveFormat(sampleRate, 16, 1)))
                {
                    // Convert float -> 16-bit PCM by hand instead of WriteSamples.
                    //
                    // WriteSamples routes float-to-PCM through Windows ACM, and ACM
                    // intermittently refuses with "Not implemented" - which is what
                    // produced one failed loopback segment per second for stretches
                    // at a time (the pump retried in a tight loop). Writing the
                    // bytes ourselves removes ACM from the path entirely.
                    int read;
                    byte[] pcm = new byte[4096 * 2];
                    while ((read = chain.Read(buf, 0, buf.Length)) > 0)
                    {
                        for (int i = 0; i < read; i++)
                        {
                            double a = Math.Abs(buf[i]);
                            if (a > peak) peak = a;
                            sum += (double)buf[i] * (double)buf[i];
                            n++;
                            double v = buf[i];
                            if (v > 1.0) v = 1.0;
                            else if (v < -1.0) v = -1.0;
                            short s16 = (short)Math.Round(v * 32767.0);
                            pcm[i * 2] = (byte)(s16 & 0xFF);
                            pcm[i * 2 + 1] = (byte)((s16 >> 8) & 0xFF);
                        }
                        outW.Write(pcm, 0, read * 2);
                    }
                }
                res.Peak = peak;
                res.Rms = n > 0 ? Math.Sqrt(sum / n) : 0.0;
            }
        }
        finally
        {
            try { capture.Dispose(); } catch { }
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            sw.Stop();
        }
        res.Milliseconds = (int)sw.Elapsed.TotalMilliseconds;
        res.Bytes = File.Exists(outPath) ? (int)new FileInfo(outPath).Length : 0;
        return res;
    }

    public static string Describe()
    {
        string s = "";
        try
        {
            using (NAudio.CoreAudioApi.MMDeviceEnumerator en = new NAudio.CoreAudioApi.MMDeviceEnumerator())
            {
                var def = en.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Render, NAudio.CoreAudioApi.Role.Multimedia);
                s += "render=" + def.FriendlyName;
                var mic = en.GetDefaultAudioEndpoint(NAudio.CoreAudioApi.DataFlow.Capture, NAudio.CoreAudioApi.Role.Multimedia);
                s += " mic=" + mic.FriendlyName;
            }
        }
        catch (Exception e) { s += " error=" + e.Message; }
        return s;
    }
}
