#[cfg(target_os = "macos")]
mod platform {
  use block2::RcBlock;
  use objc2::runtime::{AnyClass, AnyObject, Bool};
  use objc2::{class, msg_send, sel};
  use serde::Serialize;
  use std::ffi::CStr;
  use tauri::{AppHandle, Emitter};

  #[link(name = "MediaPlayer", kind = "framework")]
  extern "C" {}

  #[link(name = "AVFAudio", kind = "framework")]
  extern "C" {}

  #[derive(Clone, Serialize)]
  struct HardwareCallControlPayload {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    muted: Option<bool>,
  }

  fn emit_action(app: &AppHandle, action: &str) {
    emit_payload(app, action, None);
  }

  fn emit_payload(app: &AppHandle, action: &str, muted: Option<bool>) {
    let _ = app.emit(
      "hardware-call-control",
      HardwareCallControlPayload {
        action: action.to_string(),
        muted,
      },
    );
  }

  unsafe fn enable_command(command: *mut AnyObject, app: AppHandle, action: &'static str) {
    if command.is_null() {
      return;
    }

    let _: () = msg_send![command, setEnabled: true];
    let block = RcBlock::new(move |_event: *mut AnyObject| -> isize {
      emit_action(&app, action);
      0
    });
    let _: *mut AnyObject = msg_send![command, addTargetWithHandler: &*block];
  }

  unsafe fn clear_command(command: *mut AnyObject) {
    if command.is_null() {
      return;
    }

    let _: () = msg_send![command, removeTarget: std::ptr::null_mut::<AnyObject>()];
    let _: () = msg_send![command, setEnabled: false];
  }

  macro_rules! enable_if_available {
    ($center:expr, $selector:ident, $app:expr, $action:expr) => {{
      let responds: bool = unsafe { msg_send![$center, respondsToSelector: sel!($selector)] };
      if responds {
        let command: *mut AnyObject = unsafe { msg_send![$center, $selector] };
        unsafe { enable_command(command, $app.clone(), $action) };
      }
    }};
  }

  macro_rules! clear_if_available {
    ($center:expr, $selector:ident) => {{
      let responds: bool = unsafe { msg_send![$center, respondsToSelector: sel!($selector)] };
      if responds {
        let command: *mut AnyObject = unsafe { msg_send![$center, $selector] };
        unsafe { clear_command(command) };
      }
    }};
  }

  pub fn set_active(app: AppHandle, _title: String, microphone_active: bool) -> Result<(), String> {
    let center: *mut AnyObject = unsafe { msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter] };
    if center.is_null() {
      return Err("MPRemoteCommandCenter is unavailable.".to_string());
    }

    clear_all(center);

    enable_if_available!(center, endCallCommand, app, "hangup");
    enable_if_available!(center, hangupCommand, app, "hangup");
    enable_if_available!(center, pauseCommand, app, "hangup");
    enable_if_available!(center, stopCommand, app, "hangup");
    enable_if_available!(center, togglePlayPauseCommand, app, "hangup");

    configure_input_mute_handler(app, !microphone_active);

    Ok(())
  }

  pub fn clear() -> Result<(), String> {
    let center: *mut AnyObject = unsafe { msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter] };
    if center.is_null() {
      return Ok(());
    }
    clear_all(center);
    clear_input_mute_handler();
    Ok(())
  }

  fn clear_all(center: *mut AnyObject) {
    clear_if_available!(center, endCallCommand);
    clear_if_available!(center, hangupCommand);
    clear_if_available!(center, pauseCommand);
    clear_if_available!(center, stopCommand);
    clear_if_available!(center, togglePlayPauseCommand);
  }

  fn audio_application() -> Option<*mut AnyObject> {
    let class_name = CStr::from_bytes_with_nul(b"AVAudioApplication\0").ok()?;
    let cls = AnyClass::get(class_name)?;
    let app: *mut AnyObject = unsafe { msg_send![cls, sharedInstance] };
    if app.is_null() {
      None
    } else {
      Some(app)
    }
  }

  fn configure_input_mute_handler(app: AppHandle, muted: bool) {
    let Some(audio_app) = audio_application() else {
      return;
    };
    let can_set_handler: bool = unsafe {
      msg_send![audio_app, respondsToSelector: sel!(setInputMuteStateChangeHandler:error:)]
    };
    if can_set_handler {
      let block = RcBlock::new(move |next_muted: Bool| -> Bool {
        emit_payload(&app, "set-microphone-muted", Some(next_muted.into()));
        Bool::YES
      });
      let _: bool = unsafe {
        msg_send![
          audio_app,
          setInputMuteStateChangeHandler: &*block,
          error: std::ptr::null_mut::<*mut AnyObject>()
        ]
      };
    }

    let can_set_muted: bool = unsafe {
      msg_send![audio_app, respondsToSelector: sel!(setInputMuted:error:)]
    };
    if can_set_muted {
      let _: bool = unsafe {
        msg_send![
          audio_app,
          setInputMuted: muted,
          error: std::ptr::null_mut::<*mut AnyObject>()
        ]
      };
    }
  }

  fn clear_input_mute_handler() {
    let Some(audio_app) = audio_application() else {
      return;
    };
    let can_set_handler: bool = unsafe {
      msg_send![audio_app, respondsToSelector: sel!(setInputMuteStateChangeHandler:error:)]
    };
    if !can_set_handler {
      return;
    }
    let _: bool = unsafe {
      msg_send![
        audio_app,
        setInputMuteStateChangeHandler: std::ptr::null_mut::<AnyObject>(),
        error: std::ptr::null_mut::<*mut AnyObject>()
      ]
    };
  }
}

#[cfg(not(target_os = "macos"))]
mod platform {
  use tauri::AppHandle;

  pub fn set_active(_app: AppHandle, _title: String, _microphone_active: bool) -> Result<(), String> {
    Ok(())
  }

  pub fn clear() -> Result<(), String> {
    Ok(())
  }
}

pub fn set_active(app: tauri::AppHandle, title: String, microphone_active: bool) -> Result<(), String> {
  platform::set_active(app, title, microphone_active)
}

pub fn clear() -> Result<(), String> {
  platform::clear()
}
