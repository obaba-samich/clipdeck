import SwiftUI
import VisionKit

struct SetupView: View {
    @EnvironmentObject var store: ServerStore
    @Environment(\.dismiss) private var dismiss
    var firstRun: Bool

    @State private var home = ""
    @State private var away = ""
    @State private var scanning = false
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if firstRun {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Connect to your PC")
                            .font(.largeTitle.weight(.bold))
                        Text("On the PC, open Clipdeck → Settings → Phone and scan the QR code.")
                            .foregroundStyle(Color.muted)
                    }
                    .padding(.top, 40)
                }

                if DataScannerViewController.isSupported {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.borderedProminent)
                }

                field("Home address", text: $home, hint: "192.168.68.105:7878",
                      note: "The address shown in Settings → Phone. Works on your Wi-Fi.")
                field("Away address (optional)", text: $away, hint: "100.x.x.x:7878",
                      note: "Your PC's Tailscale address, so the app also works away from home. Used when home doesn't answer.")

                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }

                Button {
                    Task { await save() }
                } label: {
                    Group {
                        if checking { ProgressView() } else { Text(firstRun ? "Connect" : "Save").font(.headline) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.bordered)
                .disabled(home.trimmingCharacters(in: .whitespaces).isEmpty || checking)
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.bg)
        .navigationTitle(firstRun ? "" : "Server address")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !firstRun {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .onAppear {
            home = store.home
            away = store.away
        }
        .sheet(isPresented: $scanning) {
            QRScanner { code in
                scanning = false
                home = code
                Task { await save() }
            }
            .ignoresSafeArea()
        }
    }

    private func field(_ title: String, text: Binding<String>, hint: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            TextField(hint, text: text)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 14)
                .frame(height: 46)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.line))
            Text(note).font(.footnote).foregroundStyle(Color.muted)
        }
    }

    private func save() async {
        let h = ServerStore.normalize(home)
        let a = ServerStore.normalize(away)
        guard let url = URL(string: h) else { error = "That address doesn't look right."; return }
        checking = true
        error = nil
        let ok = await ServerStore.reachable(url)
        checking = false
        if !ok && a.isEmpty {
            error = "No answer from \(h). Is Clipdeck running, and is the phone on the same Wi-Fi? (Saved anyway.)"
        }
        store.home = h
        store.away = a
        if ok || !firstRun { dismiss() }
    }
}

/// Live camera QR scanner (VisionKit).
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in items {
                if case .barcode(let b) = item, let s = b.payloadStringValue, s.hasPrefix("http") {
                    done = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    scanner.stopScanning()
                    onCode(s)
                    return
                }
            }
        }
    }
}
