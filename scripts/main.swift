// Ditherlab — native macOS wrapper.
//
// A WKWebView window around the local Ditherlab server: own Dock icon, own
// window, quits like a normal app. Starts the bundled Python static server on
// launch (unless one is already serving Ditherlab) and stops it on quit.
// Exports (PNG/GIF/video/TXT) are handled as native downloads into ~/Downloads.
//
// __PROJECT_DIR__ is substituted by scripts/build-app.sh at build time.

import Cocoa
import WebKit

let projectDir = "__PROJECT_DIR__"
// Port is dynamic: 8173 is preferred, 8271 is the fallback when a foreign
// (non-Ditherlab) process already owns 8173. Set once by startServerIfNeeded
// before pollAndLoad runs.
var appPort = 8173
var appURL = URL(string: "http://127.0.0.1:8173/")!
let testMode = ProcessInfo.processInfo.environment["DL_TEST_DOWNLOAD"] == "1"

/// Thread-safe Process holder: the spawn happens on a background queue, so a
/// plain stored property could be missed by a fast Cmd-Q (applicationWillTerminate).
final class ProcessHolder {
    private let lock = NSLock()
    private var process: Process?
    var value: Process? {
        get { lock.lock(); defer { lock.unlock() }; return process }
        set { lock.lock(); defer { lock.unlock() }; process = newValue }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let serverProcess = ProcessHolder()
    var loadDeadline = Date().addingTimeInterval(25) // cold python3 launches can take a while
    var lastDownload: URL?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        buildMenu()

        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // never serve stale modules after an update
        cfg.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Ditherlab"
        window.minSize = NSSize(width: 980, height: 620)
        window.contentView = webView
        window.backgroundColor = NSColor(calibratedWhite: 0.02, alpha: 1)
        window.center()
        window.setFrameAutosaveName("DitherlabMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServerIfNeeded() // calls pollAndLoad once the port is chosen
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { serverProcess.value?.terminate() }

    // MARK: server

    func serverResponds() -> Bool {
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: appURL, timeoutInterval: 0.6)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let d = data, let s = String(data: d, encoding: .utf8),
               s.lowercased().contains("ditherlab") { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.0)
        return ok
    }

    enum PortProbe {
        case ditherlab // a Ditherlab server already answers here — reuse it
        case foreign   // something else owns the port — do not spawn on it
        case free      // nothing answered — safe to spawn here
    }

    func probe(port: Int) -> PortProbe {
        var result = PortProbe.free
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!, timeoutInterval: 0.6)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, response, _ in
            if let d = data, let s = String(data: d, encoding: .utf8),
               s.lowercased().contains("ditherlab") {
                result = .ditherlab
            } else if data != nil || response != nil {
                result = .foreign
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.0)
        return result
    }

    func usePort(_ port: Int) {
        appPort = port
        appURL = URL(string: "http://127.0.0.1:\(port)/")!
    }

    func startServerIfNeeded() {
        DispatchQueue.global().async {
            defer { DispatchQueue.main.async { self.pollAndLoad() } }

            var spawnPort: Int?
            scan: for port in [8173, 8271] {
                switch self.probe(port: port) {
                case .ditherlab:
                    self.usePort(port) // reuse the existing Ditherlab server
                    return
                case .foreign:
                    continue // occupied by another program, try the next port
                case .free:
                    spawnPort = port
                    break scan
                }
            }
            guard let port = spawnPort else { return } // both ports foreign → deadline alert

            self.usePort(port)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["python3", "scripts/serve.py", String(port),
                           "--parent", String(ProcessInfo.processInfo.processIdentifier)]
            p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do {
                try p.run()
                // assign synchronously so a fast Cmd-Q always sees the process
                self.serverProcess.value = p
            } catch { /* handled by the load deadline alert */ }
        }
    }

    func pollAndLoad() {
        DispatchQueue.global().async {
            var ok = self.serverResponds()
            let expired = Date() > self.loadDeadline
            if !ok && expired { ok = self.serverResponds() } // final re-check before the fatal alert
            DispatchQueue.main.async {
                if ok {
                    self.webView.load(URLRequest(url: appURL))
                    self.scheduleTestHook()
                } else if expired {
                    self.showStartupError()
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.pollAndLoad() }
                }
            }
        }
    }

    func showStartupError() {
        let alert = NSAlert()
        alert.messageText = "Ditherlab could not start its local server"
        alert.informativeText = """
        Check that python3 is installed (run “xcode-select --install” in \
        Terminal), that the Ditherlab folder still exists at \
        \(projectDir), and that ports 8173 and 8271 are not both used by \
        other programs (tried http://127.0.0.1:\(appPort)/).
        """
        alert.alertStyle = .critical
        alert.runModal()
        if testMode { print("TEST_DOWNLOAD_FAIL: server did not start"); exit(1) }
        NSApp.terminate(nil)
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Ditherlab",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Ditherlab", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Ditherlab", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editMenu = NSMenu(title: "Edit")
        // No Undo/Redo items: they would swallow Cmd+Z before the page's own
        // keydown handler, which implements app-level undo in JS.
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        // Paste goes through the app delegate so images on the pasteboard can
        // be bridged into the page (WKWebView never fires JS 'paste' for them).
        let paste = NSMenuItem(title: "Paste", action: #selector(pasteSmart(_:)), keyEquivalent: "v")
        paste.keyEquivalentModifierMask = [.command]
        paste.target = self
        editMenu.addItem(paste)
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        let fs = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fs)
        let viewItem = NSMenuItem()
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem()
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc func reloadPage() { webView.reload() }

    // Cmd-V: if the pasteboard holds an image, hand it to the page as a data
    // URL (window.__dlNativePaste, a guarded no-op until the JS side exists);
    // otherwise forward a normal paste so text fields keep working.
    @objc func pasteSmart(_ sender: Any?) {
        let pb = NSPasteboard.general
        if let images = pb.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
           let image = images.first,
           let tiff = image.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            let b64 = png.base64EncodedString()
            webView.evaluateJavaScript(
                "window.__dlNativePaste && window.__dlNativePaste('data:image/png;base64,\(b64)')")
            return
        }
        let pasteSel = NSSelectorFromString("paste:")
        if webView.responds(to: pasteSel) {
            webView.perform(pasteSel, with: nil)
        }
    }

    // MARK: automated export test (DL_TEST_DOWNLOAD=1)

    func scheduleTestHook() {
        guard testMode else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            self.webView.evaluateJavaScript("document.getElementById('btn-export-png').click()")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            print("TEST_DOWNLOAD_FAIL: timed out")
            exit(1)
        }
    }
}

// MARK: - web view delegates

extension AppDelegate: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // external links open in the default browser, the app stays on Ditherlab
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
           url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant) // macOS still shows its own camera consent dialog
    }

    // <input type=file> needs the app to supply the picker in WKWebView
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { resp in
            completionHandler(resp == .OK ? panel.urls : nil)
        }
    }

    // downloads land in ~/Downloads with a deduplicated name
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var dest = downloads.appendingPathComponent(suggestedFilename)
        let base = dest.deletingPathExtension().lastPathComponent
        let ext = dest.pathExtension
        var i = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = downloads.appendingPathComponent("\(base)-\(i)")
            if !ext.isEmpty { dest = dest.appendingPathExtension(ext) }
            i += 1
        }
        lastDownload = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
        if testMode {
            print("TEST_DOWNLOAD_OK: \(lastDownload?.path ?? "?")")
            exit(0)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if testMode {
            print("TEST_DOWNLOAD_FAIL: \(error.localizedDescription)")
            exit(1)
        }
        let alert = NSAlert()
        alert.messageText = "Export failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
