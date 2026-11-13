//! Bounded, in-memory crops of the trusted app webview, never the desktop or a guest.
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 32_768.0
            && self.y + self.height <= 32_768.0
    }
}

#[tauri::command]
pub(crate) async fn window_snapshot<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    crop: Rect,
    redactions: Vec<Rect>,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main"
        || !crop.valid()
        || crop.width > 1280.0
        || crop.height > 960.0
        || redactions.len() > 64
        || redactions.iter().any(|r| !r.valid())
    {
        return Err("Invalid window snapshot request".into());
    }
    #[cfg(target_os = "macos")]
    {
        static CAPTURE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let _permit = CAPTURE
            .try_acquire()
            .map_err(|_| "Window snapshot is busy")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |platform| {
                use block2::RcBlock;
                use objc2::{AnyThread, MainThreadMarker};
                use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
                use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize};
                use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
                use std::cell::RefCell;
                // SAFETY: Tauri/Wry supplies the live WKWebView on its main thread.
                let view = unsafe { &*platform.inner().cast::<WKWebView>() };
                let bounds = view.bounds();
                if crop.x + crop.width > bounds.size.width
                    || crop.y + crop.height > bounds.size.height
                {
                    let _ = send.send(Err("Snapshot lies outside the app window".to_owned()));
                    return;
                }
                let Some(main) = MainThreadMarker::new() else {
                    let _ = send.send(Err("Snapshot requires the main thread".to_owned()));
                    return;
                };
                let configuration = unsafe { WKSnapshotConfiguration::new(main) };
                let y = if view.isFlipped() {
                    crop.y
                } else {
                    bounds.size.height - crop.y - crop.height
                };
                unsafe {
                    configuration.setRect(NSRect::new(
                        NSPoint::new(crop.x, y),
                        NSSize::new(crop.width, crop.height),
                    ));
                }
                let send = RefCell::new(Some(send));
                let complete = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                    let result = (|| {
                        // SAFETY: WebKit keeps callback parameters alive for the call.
                        let image = unsafe { image.as_ref() }
                            .ok_or("Could not capture this part of the window")?;
                        let tiff = image
                            .TIFFRepresentation()
                            .ok_or("Could not read the window snapshot")?;
                        let bitmap =
                            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                                .ok_or("Could not decode the window snapshot")?;
                        let png = unsafe {
                            bitmap.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        }
                        .ok_or("Could not encode the window snapshot")?;
                        Ok(png.to_vec())
                    })()
                    .map_err(str::to_owned);
                    if let Some(send) = send.borrow_mut().take() {
                        let _ = send.send(result);
                    }
                });
                unsafe {
                    view.takeSnapshotWithConfiguration_completionHandler(
                        Some(&configuration),
                        &complete,
                    );
                }
            })
            .map_err(|_| "Could not access the app window")?;
        let png = tokio::time::timeout(std::time::Duration::from_secs(3), receive)
            .await
            .map_err(|_| "Window snapshot timed out")?
            .map_err(|_| "Window snapshot was cancelled")??;
        tauri::async_runtime::spawn_blocking(move || redact(&png, crop, &redactions))
            .await
            .map_err(|_| "Could not prepare the window snapshot")?
            .map(tauri::ipc::Response::new)
    }
    #[cfg(not(target_os = "macos"))]
    Err("Window snapshots are currently available on Mac desktop only".into())
}

#[cfg(any(target_os = "macos", test))]
fn redact(png: &[u8], crop: Rect, redactions: &[Rect]) -> Result<Vec<u8>, String> {
    use image::GenericImage;
    let mut image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|_| "Could not read the window snapshot")?;
    if image.width() > 1280 || image.height() > 960 {
        image = image.thumbnail(1280, 960);
    }
    let sx = f64::from(image.width()) / crop.width;
    let sy = f64::from(image.height()) / crop.height;
    for rect in redactions {
        let left = ((rect.x - crop.x) * sx).floor().max(0.0) as u32;
        let top = ((rect.y - crop.y) * sy).floor().max(0.0) as u32;
        let right = ((rect.x + rect.width - crop.x) * sx).ceil().max(0.0) as u32;
        let bottom = ((rect.y + rect.height - crop.y) * sy).ceil().max(0.0) as u32;
        for y in top..bottom.min(image.height()) {
            for x in left..right.min(image.width()) {
                image.put_pixel(x, y, image::Rgba([128, 128, 128, 255]));
            }
        }
    }
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "Could not prepare the window snapshot")?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    #[test]
    fn redacts_editor_pixels_at_backing_scale_without_changing_other_pixels() {
        let source = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            8,
            image::Rgba([10, 20, 30, 255]),
        ));
        let mut png = std::io::Cursor::new(Vec::new());
        source.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let crop = Rect {
            x: 10.0,
            y: 20.0,
            width: 4.0,
            height: 4.0,
        };
        let bytes = redact(
            png.get_ref(),
            crop,
            &[Rect {
                x: 11.0,
                y: 21.0,
                width: 1.0,
                height: 1.0,
            }],
        )
        .unwrap();
        let result = image::load_from_memory(&bytes).unwrap();
        assert_eq!(result.dimensions(), (8, 8));
        assert_eq!(result.get_pixel(2, 2), image::Rgba([128, 128, 128, 255]));
        assert_eq!(result.get_pixel(3, 3), image::Rgba([128, 128, 128, 255]));
        assert_eq!(result.get_pixel(0, 0), source.get_pixel(0, 0));
        assert_eq!(result.get_pixel(4, 4), source.get_pixel(4, 4));
    }

    #[tokio::test]
    async fn refuses_other_webviews_and_invalid_geometry_before_capturing() {
        use tauri::{test::mock_builder, WebviewUrl, WebviewWindowBuilder};
        let app = mock_builder().build(crate::app_context()).unwrap();
        let guest = WebviewWindowBuilder::new(&app, "browser-content", WebviewUrl::default())
            .build()
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let crop = Rect {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
        };
        assert!(window_snapshot(guest, crop, vec![]).await.is_err());
        for invalid in [
            Rect {
                x: f64::NAN,
                ..crop
            },
            Rect {
                width: 1281.0,
                ..crop
            },
            Rect {
                height: 0.0,
                ..crop
            },
        ] {
            assert!(window_snapshot(main.clone(), invalid, vec![])
                .await
                .is_err());
        }
        assert!(window_snapshot(main, crop, vec![crop; 65]).await.is_err());
    }
}
