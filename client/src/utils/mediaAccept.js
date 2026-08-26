// One accept list for every file input that takes a rack photo.
//
// The lists used to be written inline as `image/*,image/heic,image/heif,.heic,.heif`
// — and the two bare extensions at the end are what put a *sound recorder* in the
// Android picker. Chrome builds its chooser by looking at the accept list as a
// whole: when every entry is an `image/…` MIME type it opens the image scope
// (camera + gallery), but a single entry it can't classify — a bare `.heic`, or a
// `video/*` mixed into an image input — drops it to the generic scope, which offers
// Camera, Camcorder AND Sound Recorder. Testers saw the audio option there and,
// worse, could pick a file the scan pipeline can never read.
//
// So: MIME types only, all of them images, and JPEG spelled out rather than left to
// the `image/*` wildcard — `image/jpg` and `image/pjpeg` are non-standard but are
// what several Android gallery providers actually report for a JPEG.
export const IMAGE_ACCEPT = [
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
].join(',');

// Kept as the single wildcard: one entry Chrome recognises, so the picker opens
// the video scope (camcorder + gallery) and no audio option appears here either.
export const VIDEO_ACCEPT = 'video/*';
