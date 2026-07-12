// Ditherlab — native macOS wrapper.
//
// A WKWebView window around an in-process static file server: own Dock icon,
// own window, quits like a normal app. The web assets ship inside the bundle
// (Contents/Resources/web), so the app is fully self-contained — no Python,
// no external files, no port conflicts (the server binds an ephemeral port on
// 127.0.0.1, which WebKit treats as a secure context so the webcam works).
// Exports (PNG/GIF/video/TXT) are handled as native downloads into ~/Downloads.

import Cocoa
import Network
import WebKit

var appURL = URL(string: "http://127.0.0.1/")! // real port filled in at launch
let testMode = ProcessInfo.processInfo.environment["DL_TEST_DOWNLOAD"] == "1"
let testExportTarget = ProcessInfo.processInfo.environment["DL_TEST_EXPORT"] ?? "png"

private func matchesAppOrigin(scheme: String?, host: String?, port: Int?) -> Bool {
    guard let scheme, let host,
          let appScheme = appURL.scheme, let appHost = appURL.host else { return false }
    return scheme.caseInsensitiveCompare(appScheme) == .orderedSame
        && host.caseInsensitiveCompare(appHost) == .orderedSame
        && port == appURL.port
}

private func isAppOrigin(_ url: URL) -> Bool {
    matchesAppOrigin(scheme: url.scheme, host: url.host, port: url.port)
}

private func isAppOrigin(_ origin: WKSecurityOrigin) -> Bool {
    matchesAppOrigin(scheme: origin.protocol, host: origin.host, port: origin.port)
}

private func isAppBlobURL(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "blob" else { return false }
    let value = url.absoluteString
    guard value.lowercased().hasPrefix("blob:"),
          let embeddedURL = URL(string: String(value.dropFirst(5))) else { return false }
    return isAppOrigin(embeddedURL)
}

/// Minimal HTTP/1.1 static file server over Network.framework. GET/HEAD only,
/// loopback only, Cache-Control: no-store (never serve stale modules after an
/// update), dot-prefixed path segments are never served.
final class StaticServer {
    private let root: URL
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif", "svg": "image/svg+xml",
        "ico": "image/x-icon", "txt": "text/plain; charset=utf-8",
        "mp4": "video/mp4", "webm": "video/webm", "wasm": "application/wasm",
        "woff2": "font/woff2",
    ]

    init(root: URL) { self.root = root.standardizedFileURL }

    func start() throws -> UInt16 {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        l.start(queue: .global(qos: .userInitiated))
        _ = ready.wait(timeout: .now() + 5)
        guard case .ready = l.state, let p = l.port?.rawValue else {
            throw NSError(domain: "Ditherlab", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "local server failed to start"])
        }
        listener = l
        port = p
        return p
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: .global(qos: .userInitiated))
        readRequest(conn, buffer: Data())
    }

    private func readRequest(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            var buf = buffer
            if let d = data { buf.append(d) }
            if let headEnd = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(data: buf[..<headEnd.lowerBound], encoding: .utf8) ?? ""
                self.respond(conn, head: head)
            } else if isComplete || error != nil || buf.count > 64 * 1024 {
                conn.cancel()
            } else {
                self.readRequest(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let line = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        guard parts.count >= 2 else { return conn.cancel() }
        let method = String(parts[0])
        guard method == "GET" || method == "HEAD" else {
            return send(conn, status: "405 Method Not Allowed", type: "text/plain", body: Data("nope".utf8), headOnly: false)
        }
        var path = String(parts[1])
        if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        if path == "/" { path = "/index.html" }

        let segments = path.split(separator: "/").map(String.init)
        // never serve dotfiles or anything that escapes the web root
        guard !segments.isEmpty, !segments.contains(where: { $0.hasPrefix(".") || $0 == ".." }) else {
            return send(conn, status: "404 Not Found", type: "text/plain", body: Data("not found".utf8), headOnly: method == "HEAD")
        }
        var file = root
        for seg in segments { file.appendPathComponent(seg) }
        file.standardize()
        guard file.path.hasPrefix(root.path + "/") || file.path == root.path,
              let body = try? Data(contentsOf: file) else {
            return send(conn, status: "404 Not Found", type: "text/plain", body: Data("not found".utf8), headOnly: method == "HEAD")
        }
        let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        send(conn, status: "200 OK", type: type, body: body, headOnly: method == "HEAD")
    }

    private func send(_ conn: NWConnection, status: String, type: String, body: Data, headOnly: Bool) {
        let header = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(type)\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Cache-Control: no-store, must-revalidate\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        if !headOnly { out.append(body) }
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: StaticServer?
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

        startServerAndLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: server

    func startServerAndLoad() {
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"),
              FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            return showStartupError("The app bundle is missing its web assets — please re-download Ditherlab.")
        }
        let srv = StaticServer(root: webRoot)
        do {
            let port = try srv.start()
            server = srv
            appURL = URL(string: "http://127.0.0.1:\(port)/")!
            webView.load(URLRequest(url: appURL))
            scheduleTestHook()
        } catch {
            showStartupError("The local preview server could not start: \(error.localizedDescription)")
        }
    }

    func showStartupError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Ditherlab could not start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        if testMode { print("TEST_DOWNLOAD_FAIL: \(message)"); exit(1) }
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
            if testExportTarget == "video" {
                let script = """
                (() => {
                  const row = [...document.querySelectorAll('.row')]
                    .find((el) => el.querySelector('label')?.textContent === 'Style');
                  const style = row?.querySelector('select');
                  if (!style) throw new Error('animation style control missing');
                  style.value = 'breathe';
                  style.dispatchEvent(new Event('change', { bubbles: true }));
                  setTimeout(() => {
                    const lengthRow = [...document.querySelectorAll('.row')]
                      .find((el) => el.querySelector('label')?.textContent === 'Record length');
                    const length = lengthRow?.querySelector('select');
                    if (length) {
                      length.value = '3';
                      length.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    document.getElementById('btn-export-video').click();
                  }, 250);
                })()
                """
                self.webView.evaluateJavaScript(script)
            } else {
                let id = testExportTarget == "gif" ? "btn-export-gif" : "btn-export-png"
                self.webView.evaluateJavaScript("document.getElementById('\(id)').click()")
            }
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

        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }

        if isAppOrigin(url) {
            decisionHandler(.allow)
            return
        }

        // External web links leave the wrapper. In particular, a different
        // loopback port is not part of Ditherlab's ephemeral server origin.
        if scheme == "http" || scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        // The app creates blob/data URLs for exports and pasted images. Keep
        // those flows local, but only when their provenance is Ditherlab's
        // exact origin. about:blank is WebKit's only required opaque page.
        if scheme == "blob", isAppBlobURL(url) {
            decisionHandler(.allow)
            return
        }
        if scheme == "data", isAppOrigin(navigationAction.sourceFrame.securityOrigin) {
            decisionHandler(.allow)
            return
        }
        if scheme == "about", url.absoluteString.lowercased() == "about:blank" {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.cancel)
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
        // The web app requests video-only capture. Never grant capture to a
        // subframe, another loopback port, or a microphone request.
        let trustedCameraRequest = frame.isMainFrame && isAppOrigin(origin) && type == .camera
        decisionHandler(trustedCameraRequest ? .grant : .deny)
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
