//! OS notifications through the UserNotifications framework. The notification plugin's
//! NSUserNotificationCenter is dropped silently on current macOS, so the hub page calls these
//! commands instead (granted to the hub's origin only). A click opens the task's thread.

use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{ns_string, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Manager};

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the class does not implement Drop.
    #[unsafe(super = NSObject)]
    #[name = "AgentDeskNotificationDelegate"]
    #[ivars = AppHandle]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Clicked: the app comes forward and the page opens the task's thread.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse,
            done: &block2::DynBlock<dyn Fn()>) {
            let info = response.notification().request().content().userInfo();
            let task = info.objectForKey(ns_string!("task"))
                .and_then(|v| v.downcast::<NSString>().ok())
                .map(|s| s.to_string());
            if let Some(window) = self.ivars().get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(task) = task {
                    let detail = serde_json::to_string(&task).unwrap_or_default();
                    let _ = window.eval(format!(
                        "window.dispatchEvent(new CustomEvent('desk-notification-open', {{ detail: {{ task: {detail} }} }}));"
                    ));
                }
            }
            done.call(());
        }

        /// Shown even while the app is in front (the page only sends when no desk window is).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification,
            done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }
    }
);

/// The delegate the center holds weakly, kept for the app's lifetime.
struct Kept(#[allow(dead_code)] Retained<Delegate>);
// SAFETY: the delegate only reads its AppHandle, which is Send + Sync.
unsafe impl Send for Kept {}
unsafe impl Sync for Kept {}
static DELEGATE: OnceLock<Kept> = OnceLock::new();

/// Sets the click handler. Call once at setup.
pub fn init(app: &AppHandle) {
    let this = Delegate::alloc().set_ivars(app.clone());
    let delegate: Retained<Delegate> = unsafe { msg_send![super(this), init] };
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    let _ = DELEGATE.set(Kept(delegate));
}

/// Asks macOS for permission (a prompt the first time only); whether notifications may show.
pub fn authorize() -> bool {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(Some(tx));
    let done = RcBlock::new(move |granted: Bool, err: *mut NSError| {
        if let Some(err) = unsafe { err.as_ref() } {
            eprintln!("[agent-desk] notification permission: {} ({:?} {})", err.localizedDescription(), err.domain(), err.code());
        }
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(granted.as_bool());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &done,
    );
    // The prompt waits for the user.
    rx.recv_timeout(Duration::from_secs(300)).unwrap_or(false)
}

/// Shows a notification; `task`, when given, is opened by a click.
pub fn post(id: &str, title: &str, body: &str, task: Option<&str>) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    if let Some(task) = task {
        let info = NSDictionary::from_slices(&[ns_string!("task")], &[&*NSString::from_str(task)]);
        // SAFETY: a property-list dictionary of strings, as userInfo requires.
        unsafe { content.setUserInfo(Retained::cast_unchecked::<NSDictionary>(info).as_ref()) };
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    let done = RcBlock::new(|err: *mut NSError| {
        if let Some(err) = unsafe { err.as_ref() } {
            eprintln!("[agent-desk] notification not shown: {}", err.localizedDescription());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
}
