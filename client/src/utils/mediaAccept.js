// One accept list for every file input that takes a rack photo.
//
// The server reads the bytes of whatever arrives and converts any photo format
// to JPEG before the pipeline sees it, so the picker should offer every photo
// format too. Two kinds of entry do that, and they are kept apart on purpose:
//
// 1. MIME types. `image/*` plus every type a phone gallery or desktop OS is
//    known to report for a photo. JPEG is spelled out three ways because
//    `image/jpg` and `image/pjpeg` are non-standard but are what several
//    Android gallery providers actually report.
//
// 2. Bare extensions, for the desktop file dialog only. Windows knows
//    `image/heic` and `image/avif` as MIME types only once the HEIF / AV1
//    extensions are installed, so with MIME types alone the dialog's filter
//    hides those files and the user has to switch to "All files". A bare
//    `.heic` makes the file selectable directly.
//
// Android never gets the extensions. Chrome for Android builds its chooser by
// looking at the accept list as a whole: when every entry is an `image/…` MIME
// type it opens the image scope (camera + gallery), but a single entry it can't
// classify, such as a bare `.heic` on a device whose MIME map lacks it, drops it
// to the generic scope, which offers Camera, Camcorder AND Sound Recorder.
// Testers saw the audio option there and, worse, could pick a file the scan
// pipeline can never read. `image/*` stays first: the Capacitor WebView takes
// the first entry as the intent type for its own picker.
export const IMAGE_MIME_TYPES = [
  'image/*',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

export const IMAGE_EXTENSIONS = [
  '.heic', '.heif', '.avif', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.jpg', '.jpeg', '.png',
];

const currentUserAgent = () =>
  (typeof navigator !== 'undefined' && navigator.userAgent) || '';

/** The accept string for a rack-photo <input type="file">, for a given browser. */
export function imageAccept(userAgent = currentUserAgent()) {
  const android = /android/i.test(userAgent);
  return (android ? IMAGE_MIME_TYPES : [...IMAGE_MIME_TYPES, ...IMAGE_EXTENSIONS]).join(',');
}

export const IMAGE_ACCEPT = imageAccept();

// Kept as the single wildcard: one entry Chrome recognises, so the picker opens
// the video scope (camcorder + gallery) and no audio option appears here either.
export const VIDEO_ACCEPT = 'video/*';
