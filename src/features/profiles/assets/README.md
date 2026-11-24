# Selfie segmentation model

`selfie_segmenter.tflite` is the MediaPipe selfie segmenter, float16 version 1:
https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

Bundled so recording does not depend on a third-party model request. MediaPipe's
matching loader and WASM come from the integrity-locked `@mediapipe/tasks-vision`
package. The capture/composition implementation is adapted from
`block/buzz`, `desktop/src/features/profile/lib/animatedAvatarCapture.ts`,
commit `4704fbafb6d0667f93588b54d7f4cebf8e465ee6`.
