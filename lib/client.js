// dsh-quote client half.
//
// UI-integrated quote: selecting AI-generated content and clicking the
// floating "引用" button (or the per-message "引用" action) raises a quote
// card pinned just above the input box. The composer draft stays CLEAN while
// composing — the `> blockquote` is injected only at the moment of sending:
//
//  - send button: `inputActions.submit` is wrapped (defineProperty) to inject
//    the quote into the draft right before the real submit runs;
//  - Enter key: the app's Enter path calls the input machine directly and
//    bypasses inputActions.submit, so a document-level capture-phase keydown
//    listener intercepts Enter (only while a quote card is pending and the
//    focus is in the composer textarea), injects the quote, then calls
//    inputActions.submit() — the exact same submission the button would do.
//
// Guards keep the interception from breaking normal typing: IME composition,
// modifier keys, key repeat, slash-command mode (draft starting with '/'), and
// focus outside the textarea all skip interception.
//
// Colors use DSH theme tokens directly (--dsw-alias-*), no hardcoded palette.
//
// The bundle must register itself with the client module loader
// (`window.__ModuleLoader__.load({ id, factory })`, factory-form CJS). No
// build step.

/** True when both ends of a selection sit inside an AI reply's body text:
 *  inside a `data-chat-flow-kind="assistant-step"` row but NOT inside the
 *  reasoning disclosure (`data-variant="think"`). Everything else — user
 *  messages, tool-call cards, headers, sidebars, any other part of the
 *  interface — is excluded, so the floating 引用 button only ever quotes
 *  what the model actually replied.
 *  Accepts element or text nodes (text nodes resolve via parentElement,
 *  matching DOM selection anchors/focuses). */
function selectionInAssistantBody(anchorNode, focusNode) {
  const insideBody = (n) => {
    if (!n) return false
    const el = n.nodeType === 1 ? n : n.parentElement
    if (!el || typeof el.closest !== 'function') return false
    return (
      !!el.closest('[data-chat-flow-kind="assistant-step"]') &&
      !el.closest('[data-variant="think"]')
    )
  }
  return insideBody(anchorNode) && insideBody(focusNode)
}

window.__ModuleLoader__.load({
  id: 'dsh-quote',
  factory: (require) => {
    const React = require('react')
    const { createElement, useEffect, useRef, useState } = React

    /** Module-shared quote state between the root overlay button and the
     *  session-scoped dock card. */
    const shared = {
      inputActions: null, // set by QuoteCard (session bridge)
      input: null, // latest InputState snapshot (set by QuoteCard)
      pendingQuote: null, // { text, label } | null
      onChange: null, // QuoteCard's setState, invoked on every change
    }
    function setPendingQuote(q) {
      shared.pendingQuote = q
      if (shared.onChange) shared.onChange(q)
    }

    /** Pasting more than this many characters triggers the quote card
     *  instead of flooding the composer. */
    const PASTE_QUOTE_THRESHOLD = 300

    /** Locate the composer textarea: prefer the one matching the live draft,
     *  otherwise the largest textarea on the page. */
    function findComposerTextarea(inputRef) {
      const all = Array.from(document.querySelectorAll('textarea'))
      if (!all.length) return null
      const draft = (inputRef && inputRef.current && inputRef.current.draft) || ''
      if (draft) {
        const byValue = all.find((t) => t.value === draft)
        if (byValue) return byValue
      }
      return all
        .map((t) => {
          const r = t.getBoundingClientRect()
          return { t, area: (r.width || 0) * (r.height || 0) }
        })
        .sort((x, y) => y.area - x.area)[0].t
    }

    /** One markdown blockquote from raw text (multi-line safe). */
    function buildQuote(text) {
      return text
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n')
    }

    /** Quote + existing draft, quote first so the user's own words follow it. */
    function composeDraft(quote, draft) {
      const current = (draft || '').trim()
      return current ? quote + '\n\n' + current : quote
    }

    /** Current draft text from the shared snapshot (best effort). */
    function currentDraft() {
      return (shared.input && shared.input.draft) || ''
    }

    /** Inject the pending quote into the draft and clear the card. */
    function injectQuoteNow(q) {
      const quote = buildQuote(q.text)
      const next = composeDraft(quote, currentDraft())
      if (shared.inputActions) {
        shared.inputActions.setDraft(next)
      } else {
        fallbackSetDraft(next)
      }
      setPendingQuote(null)
    }

    /** Best-effort focus of the composer textarea (guarded DOM access). */
    function focusComposer() {
      try {
        if (typeof document === 'undefined') return
        const ta = document.querySelector('textarea')
        if (ta) ta.focus()
      } catch {
        /* non-fatal */
      }
    }

    /** Last-resort draft write when the input store is unreachable (native
     *  setter + input event keeps React-controlled textareas in sync). */
    function fallbackSetDraft(text) {
      try {
        if (typeof document === 'undefined' || typeof window === 'undefined') return false
        const ta = document.querySelector('textarea')
        if (!ta) return false
        const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value')
        if (!desc || !desc.set) return false
        desc.set.call(ta, text)
        ta.dispatchEvent(new window.Event('input', { bubbles: true }))
        return true
      } catch {
        return false
      }
    }

    /** Extract the finalized assistant message text by its durable message id. */
    function extractMessageText(session, messageId) {
      try {
        if (!session || !session.chat || !session.chat.nodes || !messageId) return ''
        const node = session.chat.nodes
          .values()
          .find(
            (n) =>
              n &&
              n.kind === 'assistant-step' &&
              n.data &&
              n.data.finalNode &&
              n.data.finalNode.messageId === messageId,
          )
        if (!node || !node.data || !Array.isArray(node.data.blocks)) return ''
        return node.data.blocks
          .filter(
            (b) => b && (b.kind === 'text' || b.kind === 'reasoning') && typeof b.text === 'string',
          )
          .map((b) => b.text)
          .join('\n\n')
      } catch {
        return ''
      }
    }

    /** Floating selection quote button, rendered in the frame-wide overlay. */
    function FloatQuote() {
      const [mark, setMark] = useState(null) // { text, left, top }

      useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
        const update = () => {
          try {
            const s = window.getSelection()
            if (!s || s.isCollapsed || s.rangeCount === 0) {
              setMark(null)
              return
            }
            const text = s.toString().replace(/\s+/g, ' ').trim()
            if (!text || text.length > 8000) {
              setMark(null)
              return
            }
            const node = s.anchorNode
            const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
            if (!el) {
              setMark(null)
              return
            }
            // Never quote from editable areas (the composer itself, inputs) or
            // from inside the quote button itself.
            if (el.closest('textarea, input, [contenteditable="true"], [data-dsh-quote]')) {
              setMark(null)
              return
            }
            // Only AI reply body text may be quoted: both ends of the
            // selection must sit inside an assistant-step flow row, and
            // neither end may be inside the reasoning disclosure.
            if (!selectionInAssistantBody(s.anchorNode, s.focusNode)) {
              setMark(null)
              return
            }
            const rect = s.getRangeAt(0).getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              setMark(null)
              return
            }
            const top = Math.max(4, rect.top - 34)
            const left = Math.min(Math.max(4, rect.left), window.innerWidth - 90)
            setMark({ text, left, top })
          } catch {
            setMark(null)
          }
        }
        const onPointer = () => {
          // Selection settles after pointerup; re-check on the next tick.
          window.setTimeout(update, 0)
        }
        document.addEventListener('selectionchange', update)
        document.addEventListener('pointerup', onPointer)
        document.addEventListener('keyup', update)
        return () => {
          document.removeEventListener('selectionchange', update)
          document.removeEventListener('pointerup', onPointer)
          document.removeEventListener('keyup', update)
        }
      }, [])

      if (!mark) return null

      const onClick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          if (shared.inputActions) {
            // UI card path: the quote is injected at send time, so the draft
            // stays clean while composing.
            setPendingQuote({ text: mark.text, label: '引用' })
          } else {
            // No session bridge mounted: fall back to writing the draft now.
            const draft = currentDraft()
            fallbackSetDraft(composeDraft(buildQuote(mark.text), draft))
          }
          const s = window.getSelection()
          if (s) s.removeAllRanges()
          focusComposer()
        } catch {
          /* ignore */
        }
        setMark(null)
      }

      return createElement(
        'button',
        {
          type: 'button',
          'data-dsh-quote': 'selection',
          onMouseDown: (e) => e.preventDefault(), // keep the selection alive
          onClick,
          style: {
            position: 'fixed',
            left: mark.left + 'px',
            top: mark.top + 'px',
            zIndex: 2147483000,
            pointerEvents: 'auto',
            padding: '5px 16px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(0,0,0,0.10)',
            fontFamily: 'inherit',
          },
        },
        '引用',
      )
    }

    /**
     * Quote card pinned just above the composer textarea (fixed positioning,
     * inside the input card): shows the pending quote as UI confirmation; the
     * × clears it without touching the draft. Doubles as the session bridge
     * (forwards inputActions + input to the floating button) and owns the two
     * send-time injection seams (submit wrapper + Enter capture).
     */
    function QuoteCard({ inputActions, input }) {
      const [pending, setPending] = useState(shared.pendingQuote)
      const [pos, setPos] = useState(null) // { left, top, width }
      const inputRef = useRef(input)
      inputRef.current = input
      // Keep the shared draft snapshot fresh: the dock re-renders on every
      // input change, so assigning here beats the effect (whose deps do not
      // include the snapshot).
      shared.input = input

      useEffect(() => {
        shared.onChange = setPending
        shared.inputActions = inputActions
        shared.input = input

        // Seam 1: send-button path — wrap inputActions.submit.
        let wrapped = false
        let orig = null
        try {
          orig = typeof inputActions.submit === 'function' ? inputActions.submit : null
          if (orig) {
            const wrapper = function (...args) {
              const q = shared.pendingQuote
              if (q) {
                try {
                  // Slash-command mode: prepending the quote would break the
                  // command, so skip injection on the button path too (the
                  // card shows a hint instead).
                  const d = (inputRef.current && inputRef.current.draft) || ''
                  if (!d.trimStart().startsWith('/')) injectQuoteNow(q)
                } catch {
                  /* injection failure must never break sending */
                }
              }
              return orig.apply(this, args)
            }
            Object.defineProperty(inputActions, 'submit', {
              value: wrapper,
              writable: true,
              configurable: true,
            })
            wrapped = true
          }
        } catch {
          /* interception unavailable; send unaffected */
        }

        // Seam 2: Enter path — capture-phase keydown. The app's Enter handler
        // calls the input machine directly, so we intercept before it runs,
        // inject the quote, then submit through the same button API.
        const onKeyDownCapture = (e) => {
          const q = shared.pendingQuote
          if (!q) return
          if (e.key !== 'Enter' || e.isComposing) return
          if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
          if (e.repeat) return
          try {
            const ta = document.querySelector('textarea')
            if (!ta || !e.target || !(e.target === ta || ta.contains(e.target))) return
            const draft = (inputRef.current && inputRef.current.draft) || ''
            // Slash-command mode: let the app's own arbitration handle Enter
            // (menu selection / command submit).
            if (draft.trimStart().startsWith('/')) return
            e.preventDefault()
            e.stopPropagation()
            injectQuoteNow(q)
            if (shared.inputActions) shared.inputActions.submit()
          } catch {
            /* never break typing */
          }
        }
        // Seam 3: large paste → quote card. Pasting a big chunk into the
        // composer floods the draft; instead turn it into the quote card so
        // the textarea stays clean and the blockquote is attached on send.
        const onPasteCapture = (e) => {
          try {
            if (!e.clipboardData) return
            const text = (e.clipboardData.getData('text') || '').trim()
            if (!text || text.length < PASTE_QUOTE_THRESHOLD || text.length > 8000) return
            const ta = findComposerTextarea(inputRef)
            if (!ta || !e.target || !(e.target === ta || ta.contains(e.target))) return
            e.preventDefault()
            e.stopPropagation()
            setPendingQuote({ text, label: '粘贴' })
          } catch {
            /* never break paste */
          }
        }
        document.addEventListener('paste', onPasteCapture, true)
        document.addEventListener('keydown', onKeyDownCapture, true)

        return () => {
          document.removeEventListener('paste', onPasteCapture, true)
          document.removeEventListener('keydown', onKeyDownCapture, true)
          shared.onChange = null
          if (shared.inputActions === inputActions) {
            shared.inputActions = null
            shared.input = null
          }
          if (wrapped && orig) {
            try {
              Object.defineProperty(inputActions, 'submit', {
                value: orig,
                writable: true,
                configurable: true,
              })
            } catch {
              /* ignore */
            }
          }
        }
      }, [inputActions])

      // Placeholder strip INSIDE the input box. DSH's composer renders the
      // visible text in a separate mirror/backdrop layer over a transparent
      // textarea, so padding the textarea never moves the visible text —
      // instead we pad the SCROLL CONTAINER (the textarea's nearest ancestor
      // with overflow-y auto/scroll), which pushes the whole input content
      // down and frees a real placeholder strip at the top for the pill. A
      // short interval defends against React resets and keeps the pill glued
      // to the correct composer textarea (largest / matching the draft).
      useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
        let timer = null
        const findScroll = (ta) => {
          let el = ta.parentElement
          while (el) {
            try {
              const ov = window.getComputedStyle(el).overflowY
              if (ov === 'auto' || ov === 'scroll') return el
            } catch {
              /* ignore */
            }
            el = el.parentElement
          }
          return ta
        }
        const apply = () => {
          try {
            const ta = findComposerTextarea(inputRef)
            if (!ta) {
              setPos(null)
              return
            }
            const sc = findScroll(ta)
            if (pending) {
              sc.style.paddingTop = '38px'
              const r = sc.getBoundingClientRect()
              if (r.width === 0 && r.height === 0) {
                setPos(null)
                return
              }
              setPos({ left: r.left + 16, top: r.top + 4, width: r.width - 32 })
            } else {
              sc.style.paddingTop = ''
              setPos(null)
            }
          } catch {
            setPos(null)
          }
        }
        apply()
        timer = window.setInterval(apply, 400)
        window.addEventListener('resize', apply)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('resize', apply)
          try {
            const ta = findComposerTextarea(inputRef)
            if (ta) findScroll(ta).style.paddingTop = ''
          } catch {
            /* ignore */
          }
        }
      }, [pending])

      if (!pending || !pos) return null

      const display = pending.text.length > 140 ? pending.text.slice(0, 140) + '…' : pending.text
      const slashMode = ((inputRef.current && inputRef.current.draft) || '').trimStart().startsWith('/')

      return createElement(
        'div',
        {
          'data-dsh-quote': 'card',
          title: (pending.label || '引用') + ' — 发送时随消息附带',
          style: {
            position: 'fixed',
            left: pos.left + 'px',
            top: pos.top + 'px',
            width: pos.width + 'px',
            boxSizing: 'border-box',
            zIndex: 2147482000,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 10px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            fontSize: '12px',
            lineHeight: '1.4',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          },
        },
        createElement(
          'span',
          {
            style: {
              flex: 'none',
              padding: '1px 8px',
              borderRadius: '999px',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '11px',
              whiteSpace: 'nowrap',
            },
          },
          pending.label || '引用',
        ),
        createElement(
          'span',
          {
            style: {
              flex: '1 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          display,
        ),
        slashMode
          ? createElement(
              'span',
              {
                style: {
                  flex: 'none',
                  whiteSpace: 'nowrap',
                  color: 'var(--dsw-alias-state-warn-primary)',
                  fontSize: '11px',
                },
              },
              '斜杠命令：发送不附带引用',
            )
          : null,
        createElement(
          'button',
          {
            type: 'button',
            'data-dsh-quote': 'card-clear',
            onClick: () => setPendingQuote(null),
            title: '移除引用',
            style: {
              flex: 'none',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '14px',
              lineHeight: '1',
              cursor: 'pointer',
              padding: '0 2px',
            },
          },
          '×',
        ),
      )
    }

    /**
     * Per-message "引用" action on finalized assistant messages: raises the
     * quote card with the whole message body.
     */
    function MessageQuote({ inputActions, useSession, messageId }) {
      // SnapshotSelectorHook requires a selector — never call it bare.
      const session = useSession((s) => s)

      if (!inputActions) return null

      const onClick = () => {
        try {
          const text = extractMessageText(session, messageId)
          if (!text) return
          setPendingQuote({ text, label: '引用 AI 回复' })
          focusComposer()
        } catch {
          /* ignore */
        }
      }

      return createElement(
        'button',
        {
          type: 'button',
          'data-dsh-quote': 'message',
          onClick,
          title: '引用这条回复到输入框',
          style: {
            padding: '2px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '12px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
        '引用',
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 1) Frame-wide floating selection button (root scope).
      ctx.effect(() =>
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-quote-float' }, () =>
            createElement(FloatQuote),
          ),
        ),
      )

      // 2) Quote card above the textarea + session bridge (session scope).
      ctx.effect(() =>
        slots.inject('conversation.input.dock', () =>
          slots.register(
            { name: 'conversation.input.dock', id: 'dsh-quote-card', order: 30 },
            (props) =>
              createElement(QuoteCard, {
                inputActions: props.inputActions,
                input: props.input,
              }),
          ),
        ),
      )

      // 3) Whole-message quote action on finalized assistant messages.
      ctx.effect(() =>
        slots.inject('conversation.chat.assistant-actions', () =>
          slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'dsh-quote-message', order: 20 },
            (props) =>
              createElement(MessageQuote, {
                inputActions: props.inputActions,
                useSession: props.useSession,
                messageId: props.messageId,
              }),
          ),
        ),
      )
    }

    return { apply }
  },
})

// Test seam: expose the selection guard to the Node test runner. In the DSH
// browser bundle `module` is undefined, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectionInAssistantBody }
}
