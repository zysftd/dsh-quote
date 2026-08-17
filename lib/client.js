// dsh-quote client half.
//
// UI-integrated quote: selecting AI-generated content and clicking the
// floating "引用" button (or the per-message "引用" action) writes the quote
// into the composer draft as a `> blockquote` IMMEDIATELY (through the input
// store's setDraft), so any send path — Enter key or the send button — is
// guaranteed to carry the quote. A white quote card pinned above the input
// box doubles as the visual confirmation and offers an × that strips the
// injected quote back out of the draft.
//
// Why not intercept submit? The Enter-key send path calls the input machine
// directly (keyboard.submit) and bypasses inputActions.submit entirely, so a
// submit wrapper cannot cover the common case.
//
// The bundle must register itself with the client module loader
// (`window.__ModuleLoader__.load({ id, factory })`, factory-form CJS). No
// build step.
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
      pendingQuote: null, // { text, label, prevDraft } | null
      onChange: null, // QuoteCard's setState, invoked on every change
    }
    function setPendingQuote(q) {
      shared.pendingQuote = q
      if (shared.onChange) shared.onChange(q)
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

    /** Write the draft through the input store, or the DOM fallback. */
    function writeDraft(text) {
      if (shared.inputActions) {
        shared.inputActions.setDraft(text)
        return true
      }
      return fallbackSetDraft(text)
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
          const prev = currentDraft()
          const quote = buildQuote(mark.text)
          const next = composeDraft(quote, prev)
          if (writeDraft(next)) {
            setPendingQuote({ text: mark.text, label: '引用', prevDraft: prev })
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
     * inside the input card): shows the pending quote as UI confirmation and
     * offers an × that strips the injected blockquote back out of the draft.
     * Also doubles as the session bridge (forwards inputActions + input to the
     * floating selection button).
     */
    function QuoteCard({ inputActions, input }) {
      const [pending, setPending] = useState(shared.pendingQuote)
      const [pos, setPos] = useState(null) // { left, top, width }
      const inputRef = useRef(input)
      inputRef.current = input

      useEffect(() => {
        shared.onChange = setPending
        shared.inputActions = inputActions
        shared.input = input
        return () => {
          shared.onChange = null
          if (shared.inputActions === inputActions) {
            shared.inputActions = null
            shared.input = null
          }
        }
      }, [inputActions])

      // Pin the chip just above the composer textarea, inside the input card.
      useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
        const measure = () => {
          try {
            const ta = document.querySelector('textarea')
            if (!ta) {
              setPos(null)
              return
            }
            const r = ta.getBoundingClientRect()
            if (r.width === 0 && r.height === 0) {
              setPos(null)
              return
            }
            setPos({ left: r.left, top: r.top - 24, width: r.width })
          } catch {
            setPos(null)
          }
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [pending])

      if (!pending || !pos) return null

      const display = pending.text.length > 240 ? pending.text.slice(0, 240) + '…' : pending.text

      const onClear = () => {
        try {
          const q = shared.pendingQuote
          if (q) {
            const cur = (inputRef.current && inputRef.current.draft) || ''
            const prefix = buildQuote(q.text) + '\n\n'
            const next = cur.startsWith(prefix) ? cur.slice(prefix.length) : q.prevDraft || ''
            if (shared.inputActions) shared.inputActions.setDraft(next)
            else fallbackSetDraft(next)
          }
        } catch {
          /* ignore */
        }
        setPendingQuote(null)
      }

      return createElement(
        'div',
        {
          'data-dsh-quote': 'card',
          style: {
            position: 'fixed',
            left: pos.left + 'px',
            top: pos.top + 'px',
            width: pos.width + 'px',
            transform: 'translateY(-100%)',
            boxSizing: 'border-box',
            zIndex: 2147482000,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '10px 16px',
            borderRadius: '16px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            fontSize: '13px',
            lineHeight: '1.5',
          },
        },
        createElement(
          'span',
          {
            style: {
              flex: 'none',
              marginTop: '1px',
              padding: '2px 10px',
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
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '76px',
              overflow: 'hidden',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          display,
        ),
        createElement(
          'button',
          {
            type: 'button',
            'data-dsh-quote': 'card-clear',
            onClick: onClear,
            title: '移除引用',
            style: {
              flex: 'none',
              marginTop: '1px',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '16px',
              lineHeight: '1',
              cursor: 'pointer',
              padding: '2px 4px',
            },
          },
          '×',
        ),
      )
    }

    /**
     * Per-message "引用" action on finalized assistant messages: quotes the
     * whole message body into the composer draft immediately.
     */
    function MessageQuote({ inputActions, useInput, useSession, messageId }) {
      // SnapshotSelectorHook requires a selector — never call these bare.
      const input = useInput((s) => s)
      const session = useSession((s) => s)

      if (!inputActions) return null

      const onClick = () => {
        try {
          const text = extractMessageText(session, messageId)
          if (!text) return
          const prev = (input && input.draft) || ''
          const quote = buildQuote(text)
          const next = composeDraft(quote, prev)
          inputActions.setDraft(next)
          setPendingQuote({ text, label: '引用 AI 回复', prevDraft: prev })
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
