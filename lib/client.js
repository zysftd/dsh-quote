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
window.__ModuleLoader__.load({
  id: 'dsh-quote',
  factory: (require) => {
    const React = require('react')
    const { createElement, useEffect, useState } = React

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

    /**
     * Floating selection quote button. Rendered into the InputBar overlay
     * anchor (session scope), so it receives `inputActions` + `useInput`
     * standard props. Renders nothing while there is no usable selection.
     */
    function SelectionQuote({ inputActions, useInput }) {
      const input = useInput()
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
            // Never quote from editable areas (the composer itself, inputs, the
            // quote button itself).
            if (el.closest('textarea, input, [contenteditable="true"], button, [data-dsh-quote]')) {
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

      if (!mark || !inputActions) return null

      const onClick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          const quote = buildQuote(mark.text)
          inputActions.setDraft(composeDraft(quote, input && input.draft))
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
            padding: '4px 12px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border, #444)',
            background: 'var(--dsw-alias-bg-elevated, #222)',
            color: 'var(--dsw-alias-fg, #eee)',
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
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
            border: '1px solid var(--dsw-alias-border, #444)',
            background: 'transparent',
            color: 'var(--dsw-alias-fg-muted, #aaa)',
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

      // 1) Selection floating button, anchored in the InputBar overlay layer.
      ctx.effect(() =>
        slots.inject('conversation.input.overlay', () =>
          slots.register(
            { name: 'conversation.input.overlay', id: 'dsh-quote-selection' },
            (props) =>
              createElement(SelectionQuote, {
                inputActions: props.inputActions,
                useInput: props.useInput,
              }),
          ),
        ),
      )

      // 2) Whole-message quote action on finalized assistant messages.
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
