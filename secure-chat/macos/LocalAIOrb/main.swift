import AppKit
import Foundation
import QuartzCore
import SwiftUI

private let tokenPath = "/Users/hun/PrivateAI/data/secure-chat/mac-orb.token"
private let chatURL = URL(string: "http://127.0.0.1:18791/api/room/say")!
private let positionKey = "orb.origin.v3"
private let sizeKey = "orb.diameter.v3"
private let roomSizeKey = "orb.room.size.v3"

enum OrbMetrics {
    static let minDiameter: CGFloat = 52
    static let maxDiameter: CGFloat = 128
    static let defaultDiameter: CGFloat = 64
    static let edgeMargin: CGFloat = 16
    static let presets: [(String, CGFloat)] = [
        ("작게", 52),
        ("보통", 64),
        ("크게", 88),
        ("아주 크게", 112),
    ]

    static func clamp(_ value: CGFloat) -> CGFloat {
        min(maxDiameter, max(minDiameter, value.rounded()))
    }
}

final class OrbPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class ChatClient {
    func ask(_ text: String, token: String) async throws -> String {
        var request = URLRequest(url: chatURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 180
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "stream": false,
            "text": text,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "LocalAIOrb", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "맥 로컬이 답을 못 냈다.",
            ])
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let messages = json?["messages"] as? [[String: Any]]
        let last = messages?.last(where: { ($0["role"] as? String) == "assistant" })
        let content = last?["content"] as? String
        guard let content, !content.isEmpty else {
            throw NSError(domain: "LocalAIOrb", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "응답이 비어 있다.",
            ])
        }
        return content
    }
}

struct Line: Identifiable, Equatable {
    let id = UUID()
    let mine: Bool
    let text: String
}

final class OrbState: ObservableObject {
    @Published var diameter: CGFloat
    @Published var pressed = false
    @Published var hovered = false
    @Published var expanded = false
    @Published var busy = false
    @Published var draft = ""
    @Published var lines: [Line] = []

    init(diameter: CGFloat) {
        self.diameter = diameter
    }
}

struct OrbGlyph: View {
    @ObservedObject var state: OrbState

    var body: some View {
        let side = state.diameter
        ZStack {
            Circle()
                .fill(.ultraThinMaterial)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.white.opacity(0.34),
                            Color.white.opacity(0.06),
                            Color.clear,
                        ],
                        center: .init(x: 0.38, y: 0.28),
                        startRadius: 2,
                        endRadius: side * 0.72
                    )
                )
            Circle()
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.55),
                            Color.white.opacity(0.12),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 0.8
                )
            Text("H")
                .font(.system(size: side * 0.36, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.96))
                .shadow(color: .black.opacity(0.18), radius: 0.5, y: 0.5)
                .frame(width: side, height: side, alignment: .center)
                .offset(y: -side * 0.01)
        }
        .frame(width: side, height: side)
        .contentShape(Circle())
        .scaleEffect(state.pressed ? 0.94 : (state.hovered ? 1.045 : 1))
        .shadow(color: .black.opacity(0.34), radius: side * 0.16, y: side * 0.08)
        .animation(.spring(response: 0.28, dampingFraction: 0.78), value: state.pressed)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: state.hovered)
        .accessibilityLabel("로컬 AI")
        .accessibilityHint("드래그해서 옮기고, 눌러서 방을 엽니다. 핀치로 크기를 바꿉니다.")
    }
}

struct RoomView: View {
    @ObservedObject var state: OrbState
    var onClose: () -> Void
    var onSend: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button(action: onClose) {
                    ZStack {
                        Circle().fill(.white.opacity(0.1))
                        Text("H")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                    }
                    .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                Text("이 방")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if state.lines.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("맥에서만 답한다")
                                    .font(.system(size: 22, weight: .semibold))
                                Text("아래 칸에 말하면 된다.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.top, 28)
                        } else {
                            ForEach(state.lines) { line in
                                HStack {
                                    if line.mine { Spacer(minLength: 36) }
                                    Text(line.text)
                                        .font(.system(size: 14))
                                        .lineSpacing(3)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8)
                                        .background(line.mine ? Color.white.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                    if !line.mine { Spacer(minLength: 12) }
                                }
                                .id(line.id)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
                .onChange(of: state.lines.count) { _, _ in
                    if let last = state.lines.last {
                        withAnimation(.easeOut(duration: 0.18)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                TextField(state.busy ? "답하는 중" : "이 방에 말하기", text: $state.draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit(onSend)
                    .disabled(state.busy)
                Button(action: onSend) {
                    Image(systemName: state.busy ? "stop.fill" : "arrow.up")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.black.opacity(0.85))
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(.white.opacity(canSend || state.busy ? 0.92 : 0.28)))
                }
                .buttonStyle(.plain)
                .disabled(!state.busy && !canSend)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.white.opacity(0.08), in: Capsule())
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.8)
        )
        .shadow(color: .black.opacity(0.4), radius: 28, y: 10)
        .onAppear { focused = true }
    }

    private var canSend: Bool {
        !state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

final class HitCircle: NSView {
    var onTap: (() -> Void)?
    var onMove: ((NSPoint) -> Void)?
    var onEndDrag: (() -> Void)?
    var onResize: ((CGFloat) -> Void)?
    var onHover: ((Bool) -> Void)?
    var onPress: ((Bool) -> Void)?

    private var startOrigin = NSPoint.zero
    private var startMouse = NSPoint.zero
    private var dragged = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let radius = min(bounds.width, bounds.height) / 2
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        return hypot(point.x - center.x, point.y - center.y) <= radius ? self : nil
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }

    override func mouseDown(with event: NSEvent) {
        window?.makeKeyAndOrderFront(nil)
        startOrigin = window?.frame.origin ?? .zero
        startMouse = NSEvent.mouseLocation
        dragged = false
        onPress?(true)
    }

    override func mouseDragged(with event: NSEvent) {
        let now = NSEvent.mouseLocation
        let delta = NSPoint(x: now.x - startMouse.x, y: now.y - startMouse.y)
        if hypot(delta.x, delta.y) > 3 { dragged = true }
        guard dragged else { return }
        onMove?(NSPoint(x: startOrigin.x + delta.x, y: startOrigin.y + delta.y))
    }

    override func mouseUp(with event: NSEvent) {
        onPress?(false)
        if dragged {
            onEndDrag?()
        } else {
            onTap?()
        }
    }

    override func magnify(with event: NSEvent) {
        onResize?(bounds.width * (1 + event.magnification))
    }

    override func scrollWheel(with event: NSEvent) {
        guard abs(event.scrollingDeltaY) > 0.2 else { return }
        onResize?(bounds.width + event.scrollingDeltaY * 0.28)
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        for (title, size) in OrbMetrics.presets {
            let item = NSMenuItem(title: title, action: #selector(pick(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = size
            menu.addItem(item)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func pick(_ sender: NSMenuItem) {
        guard let size = sender.representedObject as? CGFloat else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        onResize?(size)
    }
}

final class OrbController: NSObject, NSWindowDelegate {
    private let panel = OrbPanel(
        contentRect: NSRect(x: 0, y: 0, width: 64, height: 64),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
    )
    private let client = ChatClient()
    private let state: OrbState
    private let orbHost: NSHostingView<OrbGlyph>
    private let roomHost: NSHostingView<RoomView>
    private let hit = HitCircle()
    private var roomSize = NSSize(width: 380, height: 480)

    override init() {
        let saved = CGFloat(UserDefaults.standard.double(forKey: sizeKey))
        let diameter = OrbMetrics.clamp(saved > 0 ? saved : OrbMetrics.defaultDiameter)
        state = OrbState(diameter: diameter)
        orbHost = NSHostingView(rootView: OrbGlyph(state: state))
        roomHost = NSHostingView(rootView: RoomView(state: state, onClose: {}, onSend: {}))
        super.init()
        roomHost.rootView = RoomView(
            state: state,
            onClose: { [weak self] in self?.collapse() },
            onSend: { [weak self] in self?.send() }
        )
    }

    func show() {
        if let stored = UserDefaults.standard.string(forKey: roomSizeKey) {
            let parts = stored.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 {
                roomSize = NSSize(width: max(340, parts[0]), height: max(400, parts[1]))
            }
        }
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isMovableByWindowBackground = false
        panel.delegate = self
        orbHost.wantsLayer = true
        roomHost.wantsLayer = true
        hit.onTap = { [weak self] in self?.expand() }
        hit.onMove = { [weak self] origin in self?.panel.setFrameOrigin(self?.clamp(origin) ?? origin) }
        hit.onEndDrag = { [weak self] in self?.settleWhereverDropped() }
        hit.onResize = { [weak self] value in self?.setDiameter(value) }
        hit.onHover = { [weak self] value in self?.state.hovered = value }
        hit.onPress = { [weak self] value in self?.state.pressed = value }
        restoreOrDefaultPosition()
        renderOrb(animate: false)
        panel.orderFrontRegardless()
    }

    func windowDidMove(_ notification: Notification) {
        persistOrigin()
    }

    private func restoreOrDefaultPosition() {
        if let stored = UserDefaults.standard.string(forKey: positionKey) {
            let parts = stored.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 {
                panel.setFrameOrigin(clamp(NSPoint(x: parts[0], y: parts[1])))
                return
            }
        }
        panel.setFrameOrigin(defaultOrigin())
        persistOrigin()
    }

    private func defaultOrigin() -> NSPoint {
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(
            x: vis.maxX - state.diameter - OrbMetrics.edgeMargin,
            y: vis.minY + 160
        )
    }

    private func screen(for origin: NSPoint) -> NSScreen {
        let probe = NSPoint(x: origin.x + state.diameter / 2, y: origin.y + state.diameter / 2)
        return NSScreen.screens.first { $0.frame.contains(probe) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func clamp(_ origin: NSPoint) -> NSPoint {
        let vis = screen(for: origin).visibleFrame
        let size = state.expanded ? roomSize : NSSize(width: state.diameter, height: state.diameter)
        return NSPoint(
            x: min(max(origin.x, vis.minX + 4), vis.maxX - size.width - 4),
            y: min(max(origin.y, vis.minY + 4), vis.maxY - size.height - 4)
        )
    }

    private func settleWhereverDropped() {
        let origin = clamp(panel.frame.origin)
        let target = NSRect(origin: origin, size: panel.frame.size)
        if target.origin != panel.frame.origin {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(target, display: true)
            }
        }
        persistOrigin()
    }

    private func persistOrigin() {
        UserDefaults.standard.set("\(panel.frame.minX),\(panel.frame.minY)", forKey: positionKey)
    }

    private func setDiameter(_ value: CGFloat) {
        let next = OrbMetrics.clamp(value)
        guard abs(next - state.diameter) >= 0.5 else { return }
        let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        state.diameter = next
        UserDefaults.standard.set(Double(next), forKey: sizeKey)
        guard !state.expanded else { return }
        let frame = NSRect(x: center.x - next / 2, y: center.y - next / 2, width: next, height: next)
        panel.setFrame(clampFrame(frame), display: true)
        layoutOrb()
    }

    private func clampFrame(_ frame: NSRect) -> NSRect {
        var next = frame
        next.origin = clamp(frame.origin)
        return next
    }

    private func renderOrb(animate: Bool) {
        state.expanded = false
        panel.styleMask.insert(.nonactivatingPanel)
        let frame = NSRect(x: panel.frame.minX, y: panel.frame.minY, width: state.diameter, height: state.diameter)
        panel.setFrame(clampFrame(frame), display: true, animate: animate)
        let root = NSView(frame: NSRect(origin: .zero, size: frame.size))
        root.wantsLayer = true
        orbHost.frame = root.bounds
        hit.frame = root.bounds
        root.addSubview(orbHost)
        root.addSubview(hit)
        panel.contentView = root
        layoutOrb()
    }

    private func layoutOrb() {
        orbHost.rootView = OrbGlyph(state: state)
        orbHost.frame = panel.contentView?.bounds ?? .zero
        hit.frame = panel.contentView?.bounds ?? .zero
    }

    private func expand() {
        state.expanded = true
        panel.styleMask.remove(.nonactivatingPanel)
        var frame = panel.frame
        frame.size = roomSize
        panel.setFrame(clampFrame(frame), display: true, animate: true)
        roomHost.frame = NSRect(origin: .zero, size: roomSize)
        panel.contentView = roomHost
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func collapse() {
        renderOrb(animate: true)
    }

    private func send() {
        let text = state.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !state.busy else { return }
        state.draft = ""
        state.lines.append(Line(mine: true, text: text))
        state.busy = true
        Task { @MainActor in
            defer { state.busy = false }
            do {
                let token = try String(contentsOfFile: tokenPath, encoding: .utf8)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let answer = try await client.ask(text, token: token)
                state.lines.append(Line(mine: false, text: answer))
            } catch {
                state.lines.append(Line(mine: false, text: error.localizedDescription))
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let orb = OrbController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        orb.show()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
