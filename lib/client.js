// dsh-quote client half.
//
// Two quote entry points that both write into the composer draft through the
// platform's input store (InputActions.setDraft), so the model sees a proper
// markdown blockquote with provenance instead of pasted plain text:
//
//  1. Selection quote: select any text in the page (typically AI-generated
//     chat content), a floating "引用" button appears above the selection,
//     click it to quote the selected span into the input box.
//  2. Message quote: every finalized assistant message gets a "引用" action
//     in its IconActions row that quotes the whole message body.
//
// The bundle must register itself with the client module loader
// (`window.__ModuleLoader__.load({ id, factory })`, factory-form CJS): the
// loader invokes the factory with a `require` over its seed module table and
// expects the returned module exports to carry `apply`. No build step.
//
// Layout: the floating button lives in the frame-wide `shell.overlay` layer
// (designed for floating UI, above every column and outside scroll
// containers). `InputActions` only reachable from session-scoped slots, so a
// hidden bridge component in `conversation.input.overlay` forwards the active
// session's input store into module-shared state.
window.__ModuleLoader__.load({
  id: 'dsh-quote',
  factory: (require) => {
    const React = require('react')
    const { createElement, useEffect, useState } = React

    /** Module-shared input store for the active session (set by SessionBridge). */
    const shared = { inputActions: null, input: null }

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

    /** Hidden session bridge: forwards the active session's input store.
     *  Subscribes to the draft at render time (hooks rules) and caches the
     *  latest snapshot for the frame-wide button to read on click. */
    function SessionBridge({ inputActions, useInput }) {
      const input = useInput()
      useEffect(() => {
        shared.inputActions = inputActions
        shared.input = input || null
        return () => {
          if (shared.inputActions === inputActions) {
            shared.inputActions = null
            shared.input = null
          }
        }
      }, [inputActions, input])
      return null
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
          const quote = buildQuote(mark.text)
          const draft = (shared.input && shared.input.draft) || ''
          const next = composeDraft(quote, draft)
          if (shared.inputActions) {
            shared.inputActions.setDraft(next)
          } else if (!fallbackSetDraft(next)) {
            return
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
            padding: '4px 14px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border, #d0d7de)',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            color: 'var(--dsw-alias-fg, #1f2328)',
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
            fontFamily: 'inherit',
          },
        },
        '引用',
      )
    }

    /**
     * Per-message "引用" action on finalized assistant messages: quotes the
     * whole message body into the composer.
     */
    function MessageQuote({ inputActions, useInput, useSession, messageId }) {
      const input = useInput()
      const session = useSession()

      if (!inputActions) return null

      const onClick = () => {
        try {
          const text = extractMessageText(session, messageId)
          if (!text) return
          const quote = buildQuote(text)
          inputActions.setDraft(composeDraft(quote, input && input.draft))
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
            padding: '2px 8px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border, #d0d7de)',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            color: 'var(--dsw-alias-fg-muted, #57606a)',
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

      // 2) Hidden bridge: forwards the active session's input store.
      ctx.effect(() =>
        slots.inject('conversation.input.overlay', () =>
          slots.register(
            { name: 'conversation.input.overlay', id: 'dsh-quote-bridge' },
            (props) =>
              createElement(SessionBridge, {
                inputActions: props.inputActions,
                useInput: props.useInput,
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
                useInput: props.useInput,
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
