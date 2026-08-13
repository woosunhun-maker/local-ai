import SwiftUI
import UIKit

struct MarkdownMessageView: View {
    let source: String
    private let blocks: [MarkdownBlock]

    init(source: String) {
        self.source = source
        blocks = MarkdownBlock.parse(source)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { block in
                switch block.kind {
                case .heading(let level):
                    Text(inline(block.text))
                        .font(headingFont(level))
                        .padding(.top, level == 1 ? 4 : 2)
                case .paragraph:
                    Text(inline(block.text))
                        .font(.body)
                        .lineSpacing(3)
                case .bullet:
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text("•")
                            .font(.body.weight(.bold))
                            .foregroundStyle(AppTheme.accent)
                            .accessibilityHidden(true)
                        Text(inline(block.text)).font(.body).lineSpacing(3)
                    }
                    .padding(.leading, 2)
                    .accessibilityElement(children: .combine)
                case .numbered(let number):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(number).")
                            .font(.body.monospacedDigit().weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 20, alignment: .trailing)
                        Text(inline(block.text)).font(.body).lineSpacing(3)
                    }
                case .quote:
                    HStack(alignment: .top, spacing: 10) {
                        Capsule().fill(AppTheme.accent.opacity(0.7)).frame(width: 3)
                        Text(inline(block.text)).font(.body).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                case .code(let language):
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text(language.isEmpty ? "코드" : language)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                UIPasteboard.general.string = block.text
                            } label: {
                                Label("복사", systemImage: "doc.on.doc")
                                    .font(.caption.weight(.medium))
                            }
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityHint("이 코드 블록을 클립보드에 복사합니다")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.primary.opacity(0.055))
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(block.text)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(12)
                        }
                    }
                    .background(AppTheme.secondaryBackground, in: RoundedRectangle(cornerRadius: 12))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.weight(.bold)
        case 2: return .headline.weight(.semibold)
        default: return .subheadline.weight(.semibold)
        }
    }

    private func inline(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
    }
}

private struct MarkdownBlock: Identifiable {
    enum Kind {
        case heading(Int)
        case paragraph
        case bullet
        case numbered(Int)
        case quote
        case code(String)
    }

    let id: Int
    let kind: Kind
    let text: String

    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.components(separatedBy: .newlines)
        var result: [MarkdownBlock] = []
        var paragraph: [String] = []
        var codeLines: [String] = []
        var codeLanguage = ""
        var insideCode = false

        func append(_ kind: Kind, _ text: String) {
            result.append(MarkdownBlock(id: result.count, kind: kind, text: text))
        }

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            append(.paragraph, paragraph.joined(separator: "\n"))
            paragraph.removeAll(keepingCapacity: true)
        }

        for line in lines {
            if line.hasPrefix("```") {
                if insideCode {
                    append(.code(codeLanguage), codeLines.joined(separator: "\n"))
                    codeLines.removeAll(keepingCapacity: true)
                    codeLanguage = ""
                    insideCode = false
                } else {
                    flushParagraph()
                    codeLanguage = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    insideCode = true
                }
                continue
            }
            if insideCode {
                codeLines.append(line)
                continue
            }

            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flushParagraph()
            } else if trimmed.hasPrefix("### ") {
                flushParagraph()
                append(.heading(3), String(trimmed.dropFirst(4)))
            } else if trimmed.hasPrefix("## ") {
                flushParagraph()
                append(.heading(2), String(trimmed.dropFirst(3)))
            } else if trimmed.hasPrefix("# ") {
                flushParagraph()
                append(.heading(1), String(trimmed.dropFirst(2)))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                flushParagraph()
                append(.bullet, String(trimmed.dropFirst(2)))
            } else if trimmed.hasPrefix("> ") {
                flushParagraph()
                append(.quote, String(trimmed.dropFirst(2)))
            } else if let match = trimmed.range(of: #"^\d+\.\s+"#, options: .regularExpression),
                      let number = Int(String(trimmed[..<match.upperBound].filter(\.isNumber))) {
                flushParagraph()
                append(.numbered(number), String(trimmed[match.upperBound...]))
            } else {
                paragraph.append(trimmed)
            }
        }
        if insideCode {
            append(.code(codeLanguage), codeLines.joined(separator: "\n"))
        }
        flushParagraph()
        return result
    }
}
