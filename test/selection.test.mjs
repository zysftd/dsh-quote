// Unit tests for the selection-quote guard in lib/client.js.
//
// The guard decides whether a page selection may raise the floating
// "引用" button: it must be AI reply body text only — inside a
// `data-chat-flow-kind="assistant-step"` row and outside the reasoning
// disclosure (`data-variant="think"`). User messages, tool cards, and
// every other part of the interface must not be quotable.
//
// The file is a plain script registered through window.__ModuleLoader__,
// so the test loads it in a vm sandbox (no-op loader) and picks the
// guard up from the guarded `module.exports` test seam.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Minimal fake DOM node supporting only the two attribute selectors the
 *  guard matches on. Element nodes carry `nodeType: 1`; text nodes carry
 *  `nodeType: 3` plus `parentElement` (the guard normalizes via
 *  parentElement, exactly like real DOM text nodes). */
function makeNode(tag, attrs = {}, parent = null) {
  return {
    tag,
    attrs,
    parent,
    nodeType: 1,
    closest(selector) {
      const m = /^\[([\w-]+)="([^"]+)"\]$/.exec(selector)
      if (!m) return null
      let n = this
      while (n) {
        if (n.attrs && n.attrs[m[1]] === m[2]) return n
        n = n.parent
      }
      return null
    },
  }
}

/** A chat-flow shaped like the real DSH DOM:
 *  assistant-step row containing both reply body text and the reasoning
 *  disclosure; plus a user row and a bare page node. */
function tree() {
  const think = makeNode('div', { 'data-variant': 'think' })
  const body = makeNode('span')
  const step = makeNode('div', { 'data-chat-flow-kind': 'assistant-step' })
  think.parent = step
  body.parent = step
  const user = makeNode('div', { 'data-chat-flow-kind': 'user' })
  const page = makeNode('div')
  return { think, body, step, user, page }
}

function loadGuard() {
  const sandbox = {
    window: { __ModuleLoader__: { load: () => {} } },
    module: { exports: {} },
    exports: {},
    require: () => ({}),
  }
  vm.runInNewContext(code, sandbox)
  return sandbox.module.exports.selectionInAssistantBody
}

test('allows selection inside AI reply body', () => {
  const { body } = tree()
  assert.equal(loadGuard()(body, body), true)
})

test('accepts text nodes inside the AI reply body', () => {
  const { body } = tree()
  const textNode = { nodeType: 3, parentElement: body }
  assert.equal(loadGuard()(textNode, textNode), true)
})

test('rejects selection inside a user message', () => {
  const { user } = tree()
  assert.equal(loadGuard()(user, user), false)
})

test('rejects selection in page chrome without a chat row', () => {
  const { page } = tree()
  assert.equal(loadGuard()(page, page), false)
})

test('rejects selection inside the reasoning disclosure', () => {
  const { think } = tree()
  assert.equal(loadGuard()(think, think), false)
})

test('rejects selection spanning body into reasoning of the same reply', () => {
  const { body, think } = tree()
  assert.equal(loadGuard()(body, think), false)
})

test('rejects selection spanning an AI reply into a user message', () => {
  const { body, user } = tree()
  assert.equal(loadGuard()(body, user), false)
})

test('rejects missing nodes', () => {
  assert.equal(loadGuard()(null, null), false)
})
