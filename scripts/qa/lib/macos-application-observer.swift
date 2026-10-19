import AppKit
import CoreGraphics
import Foundation

struct ApplicationRecord: Codable {
    let pid: Int32
    let name: String?
    let executable: String?
    let bundle: String?
    let bundleIdentifier: String?
    let activationPolicy: Int
}

struct DockWindow: Codable {
    let layer: Int
    let onScreen: Bool
    let bounds: [String: Double]
}

struct DisplayRecord: Codable {
    let identifier: UInt32
    let captureIndex: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Snapshot: Codable {
    let time: Double
    let applications: [ApplicationRecord]
    let dockWindows: [DockWindow]
    let mainDisplay: DisplayRecord
    let dockWindowLayer: Int
    let screenCaptureAllowed: Bool
}

func snapshot() -> Snapshot {
    let applications = NSWorkspace.shared.runningApplications.map { application in
        ApplicationRecord(
            pid: application.processIdentifier,
            name: application.localizedName,
            executable: application.executableURL?.resolvingSymlinksInPath().path,
            bundle: application.bundleURL?.resolvingSymlinksInPath().path,
            bundleIdentifier: application.bundleIdentifier,
            activationPolicy: application.activationPolicy.rawValue
        )
    }
    // CoreGraphics exposes its window metadata as an untyped CFArray of dictionaries.
    let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let dockWindows = windows.compactMap { window -> DockWindow? in
        guard window[kCGWindowOwnerName as String] as? String == "Dock" else {
            return nil
        }
        return DockWindow(
            layer: window[kCGWindowLayer as String] as? Int ?? -1,
            onScreen: window[kCGWindowIsOnscreen as String] as? Bool ?? false,
            bounds: window[kCGWindowBounds as String] as? [String: Double] ?? [:]
        )
    }
    let displayIdentifier = CGMainDisplayID()
    let displayBounds = CGDisplayBounds(displayIdentifier)
    let mainDisplay = DisplayRecord(
        identifier: displayIdentifier,
        captureIndex: 1,
        x: displayBounds.minX,
        y: displayBounds.minY,
        width: displayBounds.width,
        height: displayBounds.height
    )
    let millisecondsPerSecond = 1_000.0
    return Snapshot(
        time: Date().timeIntervalSince1970 * millisecondsPerSecond,
        applications: applications,
        dockWindows: dockWindows,
        mainDisplay: mainDisplay,
        dockWindowLayer: Int(CGWindowLevelForKey(.dockWindow)),
        screenCaptureAllowed: CGPreflightScreenCaptureAccess()
    )
}

let encoder = JSONEncoder()
let sampleInterval: TimeInterval = 0.05
let newlineByte: UInt8 = 0x0A
let timer = Timer.scheduledTimer(withTimeInterval: sampleInterval, repeats: true) { _ in
    do {
        var encoded = try encoder.encode(snapshot())
        encoded.append(newlineByte)
        FileHandle.standardOutput.write(encoded)
    } catch {
        FileHandle.standardError.write(Data("Observer encoding failed: \(error)\n".utf8))
        exit(EXIT_FAILURE)
    }
}

// AppKit caches changing application properties until the next common-mode run-loop turn.
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
