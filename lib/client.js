// dsh-quote client half.
//
// UI-integrated quote: selecting AI-generated content and clicking the
// floating "引用" button (or the per-message "引用" action) does NOT dump raw
// markdown into the composer textarea. Instead it raises a visual quote card
// above the input bar (`conversation.input.dock`); when the user sends, the
// card's content is injected into the draft as a `> blockquote` right before
// submission, so the model sees a proper quoted reference with provenance.
//
// The bundle must register itself with the client module loader
// (`window.__ModuleLoader__.load({ id, factory })`, factory-form CJS): the
// loader invokes the factory with a `require` over its seed module table and
// expects the returned module exports to carry `apply`. No build step.
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
          if (shared.inputActions) {
            // UI card path: raise the quote card above the input; the card's
            // content is injected into the draft on submit.
            setPendingQuote({ text: mark.text, label: '选中内容' })
          } else {
            // No session bridge mounted: fall back to writing the draft directly.
            const draft = (shared.input && shared.input.draft) || ''
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

    /** Quote card above the composer: shows the pending quote, wraps `submit`
     *  to inject the blockquote into the draft on send, and doubles as the
     *  session bridge (forwards inputActions + input to the floating button). */
    function QuoteCard({ inputActions, input }) {
      const [pending, setPending] = useState(shared.pendingQuote)
      const inputRef = useRef(input)
      inputRef.current = input

      useEffect(() => {
        shared.onChange = setPending
        shared.inputActions = inputActions
        shared.input = input
        const origSubmit = inputActions.submit
        inputActions.submit = function (...args) {
          const q = shared.pendingQuote
          if (q) {
            try {
              const cur = (inputRef.current && inputRef.current.draft) || ''
              inputActions.setDraft(composeDraft(buildQuote(q.text), cur))
            } catch {
              /* ignore */
            }
            setPendingQuote(null)
          }
          return origSubmit.apply(this, args)
        }
        return () => {
          shared.onChange = null
          if (shared.inputActions === inputActions) {
            shared.inputActions = null
            shared.input = null
          }
          inputActions.submit = origSubmit
        }
      }, [inputActions])

      if (!pending) return null

      const display = pending.text.length > 240 ? pending.text.slice(0, 240) + '…' : pending.text

      return createElement(
        'div',
        {
          'data-dsh-quote': 'card',
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            margin: '0 4px 6px',
            padding: '8px 12px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border, #d0d7de)',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
            fontSize: '13px',
            lineHeight: '1.5',
            color: 'var(--dsw-alias-fg, #1f2328)',
          },
        },
        createElement(
          'span',
          {
            style: {
              flex: 'none',
              padding: '1px 8px',
              borderRadius: '999px',
              background: 'var(--dsw-alias-accent, #e8edf3)',
              color: 'var(--dsw-alias-fg-muted, #57606a)',
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
              maxHeight: '72px',
              overflow: 'hidden',
              color: 'var(--dsw-alias-fg-muted, #57606a)',
            },
          },
          display,
        ),
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
              color: 'var(--dsw-alias-fg-muted, #57606a)',
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
     * Per-message "引用" action on finalized assistant messages: raises the
     * quote card with the whole message body.
     */
    function MessageQuote({ inputActions, useSession, messageId }) {
      const session = useSession()

      if (!inputActions) return null

      const onClick = () => {
        try {
          const text = extractMessageText(session, messageId)
          if (!text) return
          setPendingQuote({ text, label: 'AI 回复' })
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

      // 2) Quote card above the composer + session bridge (session scope).
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
