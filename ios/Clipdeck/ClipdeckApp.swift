import SwiftUI

extension Color {
    static let bg = Color(red: 0.043, green: 0.047, blue: 0.059)
    static let panel = Color(red: 0.082, green: 0.090, blue: 0.114)
    static let line = Color(red: 0.176, green: 0.192, blue: 0.231)
    static let accent = Color(red: 1.0, green: 0.353, blue: 0.212)
    static let muted = Color(red: 0.486, green: 0.510, blue: 0.576)
}

@main
struct ClipdeckApp: App {
    @StateObject private var store = ServerStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(.accent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: ServerStore
    @Environment(\.scenePhase) private var phase
    @State private var showSetup = false

    var body: some View {
        ZStack {
            Color.bg.ignoresSafeArea()
            if !store.configured {
                SetupView(firstRun: true)
            } else if let url = store.active {
                LibraryView(base: url, connection: store.connection, openSettings: { showSetup = true })
                    .ignoresSafeArea(edges: .bottom)
            } else if store.state == .unreachable {
                OfflineView(openSettings: { showSetup = true })
            } else {
                ProgressView().controlSize(.large)
            }
        }
        .sheet(isPresented: $showSetup) {
            NavigationStack { SetupView(firstRun: false) }
        }
        .task(id: store.home + "|" + store.away) {
            if store.configured { await store.connect() }
        }
        .onChange(of: phase) { _, p in
            // Coming back from the background: re-check, the phone may have left home Wi-Fi.
            if p == .active, store.configured, store.state != .connecting {
                Task { await store.connect() }
            }
        }
    }
}

struct OfflineView: View {
    @EnvironmentObject var store: ServerStore
    var openSettings: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Color.muted)
                .frame(width: 72, height: 72)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: 20))
            Text("Can't reach your PC")
                .font(.title3.weight(.bold))
            Text(store.away.isEmpty
                 ? "Make sure the PC is on and your phone is on the same Wi-Fi."
                 : "Make sure the PC is on, and you're on home Wi-Fi or Tailscale.")
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            HStack(spacing: 10) {
                Button("Server address", action: openSettings)
                    .buttonStyle(.bordered)
                Button {
                    Task { await store.connect() }
                } label: {
                    Text("Try again").frame(minWidth: 90)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.top, 6)
        }
    }
}
