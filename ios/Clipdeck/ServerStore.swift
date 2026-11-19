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
        for raw in [home, away] where !raw.isEmpty {
            guard let base = URL(string: Self.normalize(raw)) else { continue }
            if await Self.reachable(base) {
                active = base
                state = .connected
                connection += 1
                return
            }
        }
        state = .unreachable
    }

    static func reachable(_ base: URL) async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("api/me"))
        req.timeoutInterval = 2.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            return (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }
}
