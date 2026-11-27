#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>

typedef void (*BuzzSpeechCallback)(void *, const char *, const char *);

void buzz_huddle_recognize(const int16_t *samples, uint32_t length, void *context,
                           BuzzSpeechCallback callback) {
    AVAudioFormat *format = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:16000 channels:1 interleaved:NO];
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:length];
    if (!buffer || !buffer.int16ChannelData) {
        callback(context, NULL, "Could not prepare the microphone audio.");
        return;
    }
    buffer.frameLength = length;
    memcpy(buffer.int16ChannelData[0], samples, length * sizeof(*samples));
    dispatch_async(dispatch_get_main_queue(), ^{
        __block BOOL finished = NO;
        __block SFSpeechRecognitionTask *task = nil;
        void (^finish)(NSString *, NSString *) = ^(NSString *text, NSString *error) {
            if (finished) return;
            finished = YES;
            [task cancel];
            task = nil;
            callback(context, text.UTF8String, error.UTF8String);
        };
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (finished) return;
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    finish(nil, @"Allow speech recognition in System Settings to post Huddle transcripts.");
                    return;
                }
                SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] init];
                if (!recognizer.isAvailable || !recognizer.supportsOnDeviceRecognition) {
                    finish(nil, @"On-device speech recognition is unavailable for your Mac’s current language.");
                    return;
                }
                SFSpeechAudioBufferRecognitionRequest *request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
                request.requiresOnDeviceRecognition = YES;
                request.shouldReportPartialResults = NO;
                request.taskHint = SFSpeechRecognitionTaskHintDictation;
                [request appendAudioPCMBuffer:buffer];
                [request endAudio];
                task = [recognizer recognitionTaskWithRequest:request
                    resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                        dispatch_async(dispatch_get_main_queue(), ^{
                            if (result.isFinal) finish(result.bestTranscription.formattedString, nil);
                            else if (error) finish(nil, @"Could not transcribe the microphone audio.");
                            (void)recognizer;
                        });
                    }];
                if (!task) finish(nil, @"Could not start speech recognition.");
            });
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC),
                       dispatch_get_main_queue(), ^{
            finish(nil, @"Speech recognition timed out.");
        });
    });
}
