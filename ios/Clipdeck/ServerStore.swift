import Foundation

/// Where the Clipdeck PC is. "Home" is the Wi-Fi address; "away" is optional
/// (e.g. a Tailscale address) and is tried when home doesn't answer.
@MainActor
final class ServerStore: ObservableObject {
    @Published var home: String { didSet { UserDefaults.standard.set(home, forKey: "home") } }
    @Published var away: String { didSet { UserDefaults.standard.set(away, forKey: "away") } }
    @Published var active: URL?
    @Published var state: State = .idle
    /// Goes up on every successful connect, so the library can leave its offline page.
    @Published var connection = 0

    enum State: Equatable { case idle, connecting, connected, unreachable }

    init() {
        home = UserDefaults.standard.string(forKey: "home") ?? ""
        away = UserDefaults.standard.string(forKey: "away") ?? ""
    }

    var configured: Bool { !home.isEmpty }

    /// Home and away addresses as URLs.
    var addresses: [URL] { [home, away].filter { !$0.isEmpty }.compactMap { URL(string: Self.normalize($0)) } }

    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }
        if !s.contains("://") { s = "http://" + s }
        if var c = URLComponents(string: s) {
            if c.port == nil && c.scheme == "http" { c.port = 7878 }
            c.path = ""
            c.query = nil
            c.fragment = nil
            return c.url?.absoluteString ?? s
        }
        return s
    }

    /// Picks the first address that answers /api/me.
    func connect() async {
        state = .connecting
        // Until the first success, iOS may be showing "Allow local network?" and failing
        // requests meanwhile, so keep trying for a bit instead of reporting "can't reach".
        let tries = UserDefaults.standard.bool(forKey: "everConnected") ? 1 : 6
        for attempt in 0..<tries {
            if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
            for (i, raw) in [home, away].enumerated() where !raw.isEmpty {
                guard let base = URL(string: Self.normalize(raw)) else { continue }
                // Tailscale can take a moment to wake up; give the away address longer.
                if await Self.reachable(base, timeout: i == 0 ? 2.5 : 6) {
                    active = base
                    state = .connected
                    connection += 1
                    UserDefaults.standard.set(true, forKey: "everConnected")
                    return
                }
            }
        }
        state = .unreachable
    }

    static func reachable(_ base: URL, timeout: TimeInterval = 2.5) async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("api/me"))
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            return (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }
}
