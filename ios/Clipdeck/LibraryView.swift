import SwiftUI
import WebKit

/// The clip library (the same web app the PC serves), with native touches:
/// downloads open the iOS share sheet (Save Video, Messages, TikTok…),
/// pull to refresh, swipe back, and a link back to the server settings.
struct LibraryView: UIViewRepresentable {
    let base: URL
    /// Bumped by ServerStore on every successful connect; used to leave the offline page.
    var connection: Int = 0
    /// Every address of this PC (home + away). The login is copied to all of them.
    var addresses: [URL] = []
    var openSettings: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(openSettings: openSettings) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()  // keeps the login cookie
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "ClipdeckApp/1.0 Mobile/15E148 Safari/604.1"

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.043, green: 0.047, blue: 0.059, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = true
        web.allowsLinkPreview = false
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        if #available(iOS 16.4, *) { web.isInspectable = true }

        let refresh = UIRefreshControl()
        refresh.tintColor = .lightGray
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        context.coordinator.web = web
        context.coordinator.base = base
        web.load(URLRequest(url: base))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let c = context.coordinator
        c.openSettings = openSettings
        c.addresses = addresses
        let moved = c.base?.host != base.host || c.base?.port != base.port
        let reconnected = c.connection != connection
        c.connection = connection
        if moved || (reconnected && c.offline) {
            c.base = base
            c.offline = false
            web.load(URLRequest(url: base))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        weak var web: WKWebView?
        var base: URL?
        var connection = 0
        var offline = false
        var addresses: [URL] = []
        var openSettings: () -> Void
        private var files: [WKDownload: URL] = [:]

        init(openSettings: @escaping () -> Void) { self.openSettings = openSettings }

        @objc func reload(_ sender: UIRefreshControl) {
            web?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { sender.endRefreshing() }
        }

        private func isOurs(_ url: URL?) -> Bool {
            guard let url, let base else { return false }
            return url.host == base.host && url.port == base.port
        }

        // MARK: navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if url.scheme == "clipdeck-app" {
                if url.host == "settings" { openSettings() }
                return decisionHandler(.cancel)
            }
            if action.shouldPerformDownload { return decisionHandler(.download) }
            if !isOurs(url), ["http", "https"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)  // Discord links, docs, etc.
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            if disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType {
                return decisionHandler(.download)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        // target=_blank links (share page "open") stay in the app.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if isOurs(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        // window.confirm / alert / prompt from the web app.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(a)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let a = UIAlertController(title: prompt, message: nil, preferredStyle: .alert)
            a.addTextField { $0.text = defaultText }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
            present(a)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showOffline(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showOffline(error)
        }

        // iOS kills the web content process when the app sits in the background; reload instead of a blank screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if let url = webView.url, isOurs(url) { webView.load(URLRequest(url: url)) }
            else if let base { webView.load(URLRequest(url: base)) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard isOurs(webView.url) else { return }
            offline = false
            shareLogin(webView)
        }

        /// The login cookie is tied to one address. Copy it to the PC's other address
        /// (home Wi-Fi <-> Tailscale) so leaving home doesn't ask for the passcode again.
        private func shareLogin(_ webView: WKWebView) {
            guard let host = base?.host else { return }
            let others = Set(addresses.compactMap(\.host)).subtracting([host])
            guard !others.isEmpty else { return }
            let store = webView.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { cookies in
                guard let mine = cookies.first(where: { $0.name == "clipdeck_session" && $0.domain == host }) else { return }
                for other in others {
                    if cookies.contains(where: { $0.name == mine.name && $0.domain == other && $0.value == mine.value }) { continue }
                    var props = mine.properties ?? [:]
                    props[.domain] = other
                    if let copy = HTTPCookie(properties: props) { store.setCookie(copy) }
                }
            }
        }

        private func showOffline(_ error: Error) {
            let code = (error as NSError).code
            if code == NSURLErrorCancelled || code == 102 /* frame load interrupted (downloads) */ { return }
            offline = true
            let html = """
            <html><head><meta name='viewport' content='width=device-width,initial-scale=1'>
            <style>body{background:#0b0c0f;color:#eef0f4;font:16px -apple-system;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
            p{color:#7c8293;margin:8px 32px 22px}a{display:inline-block;margin:4px;padding:12px 18px;border-radius:12px;background:#1b1e25;border:1px solid #2d313b;color:#eef0f4;text-decoration:none;font-weight:600}
            a.p{background:#ff5a36;border-color:#ff5a36}</style></head>
            <body><div><h2>Lost connection to your PC</h2><p>\(error.localizedDescription)</p>
            <a href='clipdeck-app://settings'>Server address</a><a class='p' href='\(base?.absoluteString ?? "/")'>Try again</a></div></body></html>
            """
            web?.loadHTMLString(html, baseURL: nil)
        }

        // MARK: downloads → share sheet

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "clip.mp4" : suggestedFilename)
            try? FileManager.default.removeItem(at: dest)
            files[download] = dest
            completionHandler(dest)
            DispatchQueue.main.async { self.showProgress(true) }
        }

        func downloadDidFinish(_ download: WKDownload) {
            showProgress(false)
            guard let file = files.removeValue(forKey: download) else { return }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file) }
            present(sheet)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            showProgress(false)
            files.removeValue(forKey: download)
            let a = UIAlertController(title: "Download failed", message: error.localizedDescription, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            present(a)
        }

        private var hud: UIView?

        private func showProgress(_ on: Bool) {
            guard let web else { return }
            if on, hud == nil {
                let box = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
                box.layer.cornerRadius = 16
                box.clipsToBounds = true
                box.translatesAutoresizingMaskIntoConstraints = false
                let spin = UIActivityIndicatorView(style: .medium)
                spin.startAnimating()
                let label = UILabel()
                label.text = "Preparing clip…"
                label.font = .systemFont(ofSize: 15, weight: .semibold)
                let row = UIStackView(arrangedSubviews: [spin, label])
                row.spacing = 10
                row.translatesAutoresizingMaskIntoConstraints = false
                box.contentView.addSubview(row)
                web.addSubview(box)
                NSLayoutConstraint.activate([
                    box.centerXAnchor.constraint(equalTo: web.centerXAnchor),
                    box.centerYAnchor.constraint(equalTo: web.centerYAnchor),
                    row.topAnchor.constraint(equalTo: box.contentView.topAnchor, constant: 16),
                    row.bottomAnchor.constraint(equalTo: box.contentView.bottomAnchor, constant: -16),
                    row.leadingAnchor.constraint(equalTo: box.contentView.leadingAnchor, constant: 20),
                    row.trailingAnchor.constraint(equalTo: box.contentView.trailingAnchor, constant: -20),
                ])
                hud = box
            } else if !on {
                hud?.removeFromSuperview()
                hud = nil
            }
        }

        private func present(_ vc: UIViewController) {
            guard let root = web?.window?.rootViewController else { return }
            var top = root
            while let p = top.presentedViewController { top = p }
            if let pop = vc.popoverPresentationController, let web {
                pop.sourceView = web
                pop.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 0, height: 0)
            }
            top.present(vc, animated: true)
        }
    }
}
