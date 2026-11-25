// On-device speech-to-text, the speech service's free fallback, linked into
// the app as a static library (see build.rs) and driven through the C
// functions below by speech.rs. On macOS 26, SpeechAnalyzer's DictationTranscriber;
// before that, SFSpeechRecognizer restricted to on-device recognition. Both
// take the words the caller expects to hear as hints, and both capture
// the microphone with AVAudioEngine, so the app's own microphone grant and
// usage string apply.
//
// One recognition runs at a time. Its events go to `callback` with the
// session number the caller chose: listening, the transcript so far each time
// it changes, the final transcript once it ends, or an error. After ended or
// error, the session sends nothing more.
import AppKit
import AVFoundation
import Foundation
import Speech

public typealias VoiceCallback = @convention(c) (UInt64, Int32, UnsafePointer<CChar>?) -> Void

private enum Event: Int32 {
    case listening = 0
    case text = 1
    case ended = 2
    case error = 3
    /// The language model is downloading, the first time only.
    case downloading = 4
    /// Microphone or speech recognition access is denied; nothing follows.
    case denied = 5
}

private struct VoiceError: Error {
    let message: String
    /// Access was refused: the person has to allow it in System Settings.
    let denied: Bool
    init(_ message: String, denied: Bool = false) {
        self.message = message
        self.denied = denied
    }
}

extension NSLock {
    /// `body` holding the lock; callable from async code, unlike `lock()`.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

private let micDenied =
    "Buzz can't use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then press the microphone to try again. You can type instead."
private let speechDenied =
    "Buzz can't use speech recognition. Turn it on in System Settings → Privacy & Security → Speech Recognition, then press the microphone to try again. You can type instead."
private let unavailable = "Speech recognition isn't available on this Mac."

/// A recognition in progress: its owner can finish it, reporting the final
/// transcript, or cancel it, reporting nothing.
private protocol Recognition: AnyObject {
    func finish()
    func cancel()
}

/// The callback and session number of one recognition, which stops sending
/// once it has ended or failed.
private final class Reporter: @unchecked Sendable {
    let session: UInt64
    private let callback: VoiceCallback
    private let lock = NSLock()
    private var closed = false

    init(session: UInt64, callback: @escaping VoiceCallback) {
        self.session = session
        self.callback = callback
    }

    private func send(_ event: Event, _ text: String, last: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        if closed { return }
        if last { closed = true }
        text.withCString { callback(session, event.rawValue, $0) }
    }

    func listening() { send(.listening, "") }
    func text(_ text: String) { send(.text, text) }
    func ended(_ text: String) { send(.ended, text, last: true) }
    func failed(_ message: String) { send(.error, message, last: true) }
    func denied(_ message: String) { send(.denied, message, last: true) }
    func downloading() { send(.downloading, "") }
    /// Ends silently, for a cancelled recognition.
    func close() {
        lock.lock()
        closed = true
        lock.unlock()
    }
}

/// The current recognition, replaced by each start.
private final class Current: @unchecked Sendable {
    static let shared = Current()
    private let lock = NSLock()
    private var session: UInt64 = 0
    private var recognition: Recognition?

    /// Begins `session`, cancelling whatever was running.
    func begin(_ session: UInt64) {
        lock.lock()
        let previous = recognition
        self.session = session
        recognition = nil
        lock.unlock()
        previous?.cancel()
    }

    /// Records `session`'s recognition, unless a later start replaced it;
    /// then the recognition is cancelled at once.
    func attach(_ session: UInt64, _ next: Recognition) {
        lock.lock()
        let current = self.session == session
        if current { recognition = next }
        lock.unlock()
        if !current { next.cancel() }
    }

    func take(_ session: UInt64) -> Recognition? {
        lock.lock()
        defer { lock.unlock() }
        guard self.session == session else { return nil }
        let taken = recognition
        recognition = nil
        // A stop before the recognition attaches leaves the session ended.
        self.session = 0
        return taken
    }

    func isCurrent(_ session: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return self.session == session
    }
}

#if BUZZ_SPEECH_FILE_INPUT
    /// Debug builds only: `legacy` uses the pre-macOS 26 recognizer on any
    /// version.
    private let forceLegacy =
        ProcessInfo.processInfo.environment["BUZZ_SPEECH_RECOGNIZER"] == "legacy"
#else
    private let forceLegacy = false
#endif

private func useAnalyzer() -> Bool {
    #if compiler(>=6.2)
        if #available(macOS 26, *), !forceLegacy { return true }
    #endif
    return false
}

private func microphoneAccess() async throws {
    #if BUZZ_SPEECH_FILE_INPUT
        if fileInput != nil { return }
    #endif
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return
    case .notDetermined:
        if await AVCaptureDevice.requestAccess(for: .audio) { return }
    default: break
    }
    throw VoiceError(micDenied, denied: true)
}

#if BUZZ_SPEECH_FILE_INPUT
    /// Debug builds only (see build.rs): `BUZZ_SPEECH_AUDIO_FILE` names an
    /// audio file heard instead of the microphone, at real-time pace and then
    /// as silence until listening stops, so recognition runs end to end on a
    /// machine without a usable microphone.
    private var fileInput: URL? {
        ProcessInfo.processInfo.environment["BUZZ_SPEECH_AUDIO_FILE"].map { URL(fileURLWithPath: $0) }
    }
#endif

/// The microphone, or in debug builds a file standing in for it.
private final class AudioInput: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var running = false
    private var feeder: Thread?

    /// Starts delivering buffers, on an audio thread, in the input's format.
    func start(deliver: @escaping (AVAudioPCMBuffer) -> Void) throws {
        #if BUZZ_SPEECH_FILE_INPUT
            if let fileInput { return try play(fileInput, deliver) }
        #endif
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceError("No microphone is available.")
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            deliver(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw VoiceError("Speech recognition couldn't start the microphone.")
        }
        lock.locked { running = true }
    }

    func stop() {
        let wasRunning = lock.locked {
            defer { running = false }
            return running
        }
        guard wasRunning, feeder == nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }

    #if BUZZ_SPEECH_FILE_INPUT
        private func play(_ url: URL, _ deliver: @escaping (AVAudioPCMBuffer) -> Void) throws {
            let file = try AVAudioFile(forReading: url)
            let format = file.processingFormat
            let chunk = AVAudioFrameCount(format.sampleRate / 10)
            lock.locked { running = true }
            let thread = Thread { [self] in
                let start = Date()
                var sent = 0.0
                while lock.locked({ running }) {
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk)
                    else { return }
                    if (try? file.read(into: buffer, frameCount: chunk)) == nil || buffer.frameLength == 0 {
                        // Past the end: silence.
                        buffer.frameLength = chunk
                        if let data = buffer.floatChannelData {
                            for channel in 0..<Int(format.channelCount) {
                                memset(data[channel], 0, Int(chunk) * MemoryLayout<Float>.size)
                            }
                        }
                    }
                    deliver(buffer)
                    sent += Double(buffer.frameLength) / format.sampleRate
                    let ahead = sent - Date().timeIntervalSince(start)
                    if ahead > 0 { Thread.sleep(forTimeInterval: ahead) }
                }
            }
            feeder = thread
            thread.start()
        }
    #endif
}

// MARK: macOS 26: SpeechAnalyzer

#if compiler(>=6.2)
    @available(macOS 26, *)
    private enum Analyzer {
        static func locale() async -> Locale {
            await DictationTranscriber.supportedLocale(equivalentTo: Locale.current)
                ?? Locale(identifier: "en-US")
        }

        static func transcriber(_ locale: Locale) -> DictationTranscriber {
            DictationTranscriber(
                locale: locale,
                contentHints: [.shortForm],
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: []
            )
        }

        static func installed(_ module: DictationTranscriber) async -> Bool {
            await AssetInventory.status(forModules: [module]) == .installed
        }

        /// Installs the language model if it's missing, the first time only
        /// downloading it; `downloading` runs just before a download starts.
        static func install(
            _ module: DictationTranscriber, downloading: () -> Void = {}
        ) async throws {
            if await installed(module) { return }
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module])
            else { return }
            downloading()
            try await request.downloadAndInstall()
        }

        static func analyzer(_ module: DictationTranscriber) -> SpeechAnalyzer {
            // The model stays loaded once used, so each start after the first
            // is quick.
            SpeechAnalyzer(
                modules: [module],
                options: .init(priority: .userInitiated, modelRetention: .processLifetime)
            )
        }

        /// Loads the model ahead of the first start, if it's already on this
        /// Mac: a missing model downloads on first use, never just because
        /// the app launched.
        static func warm() async throws {
            let module = transcriber(await locale())
            guard await installed(module) else { return }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
            else { return }
            let analyzer = analyzer(module)
            try await analyzer.prepareToAnalyze(in: format)
            await analyzer.cancelAndFinishNow()
        }
    }

    @available(macOS 26, *)
    private final class AnalyzerRecognition: Recognition, @unchecked Sendable {
        private let reporter: Reporter
        private let audio = AudioInput()
        private let lock = NSLock()
        private var analyzer: SpeechAnalyzer?
        private var input: AsyncStream<AnalyzerInput>.Continuation?
        private var results: Task<Void, Never>?
        private var done = false
        private var finalized = ""
        private var volatile = ""

        init(reporter: Reporter) { self.reporter = reporter }

        private var transcript: String {
            (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        func start(hints: [String]) async throws {
            let module = Analyzer.transcriber(await Analyzer.locale())
            try await Analyzer.install(module) { [reporter] in reporter.downloading() }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
            else { throw VoiceError(unavailable) }
            let analyzer = Analyzer.analyzer(module)
            if !hints.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = hints
                try await analyzer.setContext(context)
            }
            try await analyzer.prepareToAnalyze(in: format)
            let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
            let results = Task { [weak self] in
                do {
                    for try await result in module.results {
                        self?.receive(String(result.text.characters), final: result.isFinal)
                    }
                } catch {
                    self?.fail()
                }
            }
            let stopped = lock.locked {
                self.analyzer = analyzer
                self.input = input
                self.results = results
                return done
            }
            // Stopped while preparing: finish() and cancel() found nothing
            // to stop yet.
            if stopped { return await analyzer.cancelAndFinishNow() }
            do {
                try await analyzer.start(inputSequence: stream)
                var converter: AVAudioConverter?
                try audio.start { buffer in
                    if converter == nil || converter?.inputFormat != buffer.format {
                        converter = AVAudioConverter(from: buffer.format, to: format)
                    }
                    guard let converter, let converted = convert(buffer, converter, format) else { return }
                    input.yield(AnalyzerInput(buffer: converted))
                }
            } catch {
                teardown()
                throw error
            }
            let stoppedSince = lock.locked { done }
            // Stopped while the microphone started: it must not stay on.
            if stoppedSince { return audio.stop() }
            reporter.listening()
        }

        private func receive(_ text: String, final: Bool) {
            lock.lock()
            if final {
                finalized += text
                volatile = ""
            } else {
                volatile = text
            }
            let current = transcript
            lock.unlock()
            reporter.text(current)
        }

        private func fail() {
            let finished = lock.locked { done }
            if finished { return }
            teardown()
            reporter.failed("Speech recognition stopped unexpectedly.")
        }

        private func close() -> (SpeechAnalyzer?, Task<Void, Never>?)? {
            lock.lock()
            defer { lock.unlock() }
            if done { return nil }
            done = true
            input?.finish()
            return (analyzer, results)
        }

        func finish() {
            guard let (analyzer, results) = close() else { return }
            audio.stop()
            Task {
                do {
                    try await analyzer?.finalizeAndFinishThroughEndOfInput()
                } catch {
                    await analyzer?.cancelAndFinishNow()
                }
                await results?.value
                let text = lock.locked { transcript }
                reporter.ended(text)
            }
        }

        func cancel() {
            reporter.close()
            teardown()
        }

        /// Stops everything without reporting.
        private func teardown() {
            let closed = close()
            audio.stop()
            guard let (analyzer, _) = closed else { return }
            Task { await analyzer?.cancelAndFinishNow() }
        }
    }

    /// One microphone buffer in the analyzer's format.
    private func convert(
        _ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter, _ format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, output.frameLength > 0 else { return nil }
        return output
    }
#endif

// MARK: macOS 12–25: SFSpeechRecognizer

private func speechAccess() async throws {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return
    case .notDetermined:
        let status = await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        if status == .authorized { return }
    default: break
    }
    throw VoiceError(speechDenied, denied: true)
}

/// An on-device recognizer for this Mac's language, or US English.
private func legacyRecognizer() -> SFSpeechRecognizer? {
    for recognizer in [SFSpeechRecognizer(), SFSpeechRecognizer(locale: Locale(identifier: "en-US"))] {
        if let recognizer, recognizer.supportsOnDeviceRecognition { return recognizer }
    }
    return nil
}

private final class LegacyRecognition: Recognition, @unchecked Sendable {
    private let reporter: Reporter
    private let audio = AudioInput()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private let lock = NSLock()
    private var task: SFSpeechRecognitionTask?
    private var done = false
    private var cancelled = false
    private var text = ""

    init(reporter: Reporter) { self.reporter = reporter }

    func start(hints: [String]) async throws {
        try await speechAccess()
        guard let recognizer = legacyRecognizer() else { throw VoiceError(unavailable) }
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .search
        request.contextualStrings = hints
        // Holds this recognition until its last callback: once `finish`
        // takes it from `Current`, the final words arrive after `endAudio`.
        // `receive` drops the task at the end, which frees both.
        let task = recognizer.recognitionTask(with: request) { result, error in
            self.receive(result, error)
        }
        let stopped = lock.locked {
            self.task = task
            return done
        }
        if stopped { return task.cancel() }
        do {
            try audio.start { [request] buffer in request.append(buffer) }
        } catch {
            teardown()
            throw error
        }
        let stoppedSince = lock.locked { done }
        if stoppedSince { return audio.stop() }
        reporter.listening()
    }

    private func receive(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        let over = error != nil || result?.isFinal == true
        lock.lock()
        if let result { text = result.bestTranscription.formattedString }
        if over { task = nil }
        let current = text
        let finished = done
        let quiet = cancelled
        lock.unlock()
        if quiet { return }
        if let result, result.isFinal {
            audio.stop()
            return reporter.ended(current)
        }
        if error != nil {
            audio.stop()
            // Asked to finish: what was heard is the transcript.
            return finished ? reporter.ended(current) : reporter.failed("Speech recognition stopped unexpectedly.")
        }
        if result != nil { reporter.text(current) }
    }

    func finish() {
        lock.lock()
        let already = done
        done = true
        lock.unlock()
        if already { return }
        audio.stop()
        request.endAudio()
    }

    func cancel() {
        reporter.close()
        teardown()
    }

    /// Stops everything without reporting.
    private func teardown() {
        lock.lock()
        done = true
        cancelled = true
        let task = self.task
        lock.unlock()
        audio.stop()
        task?.cancel()
    }
}

/// The hints worth giving the recognizer: names of several words and words it
/// may not know (not in the spelling dictionary, or with digits). A lone
/// ordinary word is left out. The recognizer already knows it, and such hints
/// can pull other words toward them: "star" and "general" together turned
/// "star this channel" into "Star this general".
@MainActor
private func usefulHints(_ hints: [String]) -> [String] {
    let checker = NSSpellChecker.shared
    return hints.filter { hint in
        let words = hint.split { !$0.isLetter && !$0.isNumber }
        guard words.count == 1, let word = words.first, word.allSatisfy(\.isLetter) else {
            return !words.isEmpty
        }
        let misspelled = checker.checkSpelling(
            of: String(word), startingAt: 0, language: "en", wrap: false,
            inSpellDocumentWithTag: 0, wordCount: nil)
        return misspelled.location != NSNotFound
    }
}

// MARK: C interface

/// Whether this Mac can transcribe on device.
@_cdecl("buzz_speech_available")
public func buzzVoiceAvailable() -> Bool {
    if useAnalyzer() { return true }
    return legacyRecognizer() != nil
}

/// Loads the language model ahead of listening; macOS 26 only, since the
/// older recognizer has nothing to load early.
@_cdecl("buzz_speech_prepare")
public func buzzVoicePrepare() {
    #if compiler(>=6.2)
        guard #available(macOS 26, *), useAnalyzer() else { return }
        Task { try? await Analyzer.warm() }
    #endif
}

/// Starts session `session` with newline-separated hints, cancelling any
/// recognition already running.
@_cdecl("buzz_speech_start")
public func buzzVoiceStart(_ session: UInt64, _ hints: UnsafePointer<CChar>?, _ callback: @escaping VoiceCallback) {
    let hints = hints.map { String(cString: $0) }?
        .split(separator: "\n").map(String.init) ?? []
    let reporter = Reporter(session: session, callback: callback)
    Current.shared.begin(session)
    Task {
        do {
            let hints = await usefulHints(hints)
            try await microphoneAccess()
            guard Current.shared.isCurrent(session) else { return reporter.close() }
            #if compiler(>=6.2)
                if #available(macOS 26, *), useAnalyzer() {
                    let recognition = AnalyzerRecognition(reporter: reporter)
                    Current.shared.attach(session, recognition)
                    return try await recognition.start(hints: hints)
                }
            #endif
            let recognition = LegacyRecognition(reporter: reporter)
            Current.shared.attach(session, recognition)
            try await recognition.start(hints: hints)
        } catch let error as VoiceError {
            if error.denied { reporter.denied(error.message) } else { reporter.failed(error.message) }
        } catch {
            reporter.failed("Speech recognition couldn't start.")
        }
    }
}

/// Stops listening to `session` and reports its final transcript.
@_cdecl("buzz_speech_finish")
public func buzzVoiceFinish(_ session: UInt64) {
    Current.shared.take(session)?.finish()
}

/// Stops `session` without reporting anything more.
@_cdecl("buzz_speech_cancel")
public func buzzVoiceCancel(_ session: UInt64) {
    Current.shared.take(session)?.cancel()
}
