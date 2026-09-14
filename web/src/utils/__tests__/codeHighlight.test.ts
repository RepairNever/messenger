import { describe, expect, it } from 'vitest'
import { highlightCodeToHtml } from '@/utils/codeHighlight'

describe('highlightCodeToHtml', () => {
  it.each([
    ['sql', 'SELECT id FROM users WHERE active = true;', 'language-sql'],
    ['kotlin', 'fun greet(name: String) = println(name)', 'language-kotlin'],
    ['java', 'public class App { public static void main(String[] args) {} }', 'language-java'],
    ['go', 'package main\nfunc main() { fmt.Println("hi") }', 'language-go'],
    ['diagram', '┌────────┐\n│ SCREEN │\n└───┬────┘\n    ▼', 'language-diagram'],
    ['shell', 'if [ -f package.json ]; then echo "ok"; fi', 'language-shell'],
    ['typescript', 'const value: string = "hello"', 'language-typescript'],
    ['javascript', 'const value = "hello"', 'language-javascript'],
    ['json', '{"error":"invalid_scope"}', 'language-json'],
    ['mermaid', 'flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]', 'language-mermaid'],
    ['python', 'def greet(name):\n    return f"hi {name}"', 'language-python'],
  ])('highlights explicit %s fences', (language, code, className) => {
    const html = highlightCodeToHtml(code, language)

    expect(html).toContain(className)
    expect(html).toContain('class="hljs')
    expect(html).toContain('<span class="hljs-')
  })

  it.each([
    ['ts', 'const value: string = "hello"', 'language-typescript'],
    ['js', 'const value = "hello"', 'language-javascript'],
    ['sh', 'if [ -f package.json ]; then echo "ok"; fi', 'language-shell'],
    ['zsh', 'if [ -f package.json ]; then echo "ok"; fi', 'language-shell'],
    ['postgresql', 'SELECT id FROM users WHERE active = true;', 'language-sql'],
    ['postgres', 'SELECT id FROM users WHERE active = true;', 'language-sql'],
    ['psql', 'SELECT id FROM users WHERE active = true;', 'language-sql'],
    ['mmd', 'sequenceDiagram\n  Alice->>Bob: Hello', 'language-mermaid'],
    ['ascii', '┌────────┐\n│ SCREEN │\n└───┬────┘\n    ▼', 'language-diagram'],
    ['box', '┌────────┐\n│ SCREEN │\n└───┬────┘\n    ▼', 'language-diagram'],
    ['flow', '┌────────┐\n│ SCREEN │\n└───┬────┘\n    ▼', 'language-diagram'],
  ])('normalizes the %s alias', (language, code, className) => {
    const html = highlightCodeToHtml(code, language)

    expect(html).toContain(className)
  })

  it('emits the language label only on the pre wrapper', () => {
    const html = highlightCodeToHtml('package main', 'go')

    expect(html).toContain('<pre class="markdown-code-block language-go" data-language="Go">')
    expect(html).toContain('<code class="hljs language-go">')
    expect(html).not.toContain('<code class="hljs language-go" data-language=')
  })

  it.each([
    ['SELECT id, name FROM users WHERE active = true;', 'language-sql'],
    ['package main\nfunc main() { fmt.Println("hi") }', 'language-go'],
    ['def hello(name):\n    return f"hi {name}"', 'language-python'],
  ])('autodetects unlabeled code blocks', (code, className) => {
    const html = highlightCodeToHtml(code)

    expect(html).toContain(className)
    expect(html).toContain('<span class="hljs-')
  })

  it('autodetects unlabeled curl commands as shell', () => {
    const html = highlightCodeToHtml(`curl --request POST \\
     --url 'https://uat.com/oauth/token?form=2' \\
     --header 'Content-Type: application/x-www-form-urlencoded' \\
     --header 'accept: application/json' \\
     --data client_id=3b1afc1086032e3 \\
     --data client_secret=d815e0039bbac19c3ae2ba \\
     --data grant_type=client_credentials \\
     --data scope=create_payout_transactions`)

    expect(html).toContain('language-shell')
    expect(html).toContain('data-language="Shell"')
    expect(html).not.toContain('language-sql')
    expect(html).toContain('<span class="hljs-')
  })

  it('autodetects JSON output with a trailing shell prompt marker', () => {
    const html = highlightCodeToHtml('{"error":"invalid_scope","error_description":"The requested scope is invalid, unknown, or malformed."}%')

    expect(html).toContain('language-json')
    expect(html).toContain('data-language="JSON"')
    expect(html).not.toContain('language-kotlin')
    expect(html).toContain('<span class="hljs-attr">&quot;error&quot;</span>')
  })

  it('autodetects unlabeled Mermaid diagrams', () => {
    const html = highlightCodeToHtml('flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]')

    expect(html).toContain('language-mermaid')
    expect(html).toContain('data-language="Mermaid"')
    expect(html).toContain('<span class="hljs-keyword">flowchart</span>')
  })

  it('autodetects unlabeled box-drawing flow diagrams', () => {
    const html = highlightCodeToHtml(`
┌──────────────────────────────┐
│          SCREEN 1             │
│         Main Menu             │
│  "Please choose a ticket      │
│         type:"                │
│   [11 ticket type buttons]    │
└──────────────┬────────────────┘
               │ User clicks a ticket type
               ▼
┌──────────────────────────────┐
│          SCREEN 2             │
│      Type Detail Screen       │
│   [⬅️ Back]  [➡️ Continue]    │
└──────────────────────────────┘`)

    expect(html).toContain('language-diagram')
    expect(html).toContain('data-language="Diagram"')
    expect(html).toContain('<span class="hljs-keyword">SCREEN</span>')
    expect(html).toContain('<span class="hljs-title">[11 ticket type buttons]</span>')
  })

  it('falls back to escaped plain code for low-confidence autodetection', () => {
    const html = highlightCodeToHtml('plain words only <T>')

    expect(html).toContain('plain words only &lt;T&gt;')
    expect(html).not.toContain('data-language=')
    expect(html).not.toContain('<span class="hljs-')
  })

  it('falls back from unknown explicit languages to autodetection', () => {
    const html = highlightCodeToHtml('SELECT id FROM users WHERE active = true;', 'madeuplang')

    expect(html).toContain('language-sql')
    expect(html).toContain('<span class="hljs-keyword">SELECT</span>')
  })
})
