// dsh-quote client half.
//
// UI-integrated quote: selecting AI-generated content and clicking the
// floating "引用" button (or the per-message "引用" action) raises a quote
// card pinned just above the input box; when the user sends, the card's
// content is injected into the draft as a `> blockquote` right before
// submission, so the model sees a proper quoted reference.
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
      pendingQuote: null, // { text, label } | null
      onChange: null, // QuoteCard's setState, invoked on every change
    }
    function setPendingQuote(q) {
      shared.pendingQuote = q
      if (shared.onChange) shared.onChange(q)
    }

    // ---- DSH theme-following colors -------------------------------------
    // Resolve the live --dsw-alias-* token values from the document (they
    // follow the DSH theme, not the OS scheme) so the card always matches the
    // original UI in light and dark themes alike.
    const LIGHT = {
      bg: '#ffffff',
      fg: '#1f2328',
      muted: '#57606a',
      border: '#e3e6ea',
      pillBg: '#eef1f5',
    }
    function resolveTheme() {
      try {
        if (typeof document === 'undefined' || typeof window === 'undefined') return LIGHT
        const cs = window.getComputedStyle(document.documentElement)
        const pick = (name, fb) => {
          const v = cs.getPropertyValue(name).trim()
          return v && v !== 'initial' && v !== 'inherit' ? v : fb
        }
        return {
          bg: pick('--dsw-alias-bg-overlay', LIGHT.bg),
          fg: pick('--dsw-alias-label-primary', LIGHT.fg),
          muted: pick('--dsw-alias-label-secondary', LIGHT.muted),
          border: pick('--dsw-alias-border-l1', LIGHT.border),
          pillBg: pick('--dsw-alias-bg-layer-2', LIGHT.pillBg),
        }
      } catch {
        return LIGHT
      }
    }
    let themeCache = resolveTheme()
    const themeListeners = new Set()
    function refreshTheme() {
      themeCache = resolveTheme()
      for (const fn of themeListeners) fn(themeCache)
    }
    function useResolvedTheme() {
      const [t, setT] = useState(themeCache)
      useEffect(() => {
        themeListeners.add(setT)
        setT(themeCache)
        return () => {
          themeListeners.delete(setT)
        }
      }, [])
      return t
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
      const t = useResolvedTheme()
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
            // UI card path: raise the quote card; content is injected on send.
            setPendingQuote({ text: mark.text, label: '引用' })
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
            padding: '5px 16px',
            borderRadius: '10px',
            border: '1px solid ' + t.border,
            background: t.bg,
            color: t.fg,
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
     * Quote card pinned inside the input box: registered in the input dock row
     * (reliably provides inputActions + the live InputState snapshot) but
     * rendered as a fixed-positioned chip just above the composer textarea.
     * Injects the blockquote on send through a hardened submit wrapper, and
     * doubles as the session bridge.
     */
    function QuoteCard({ inputActions, input }) {
      const t = useResolvedTheme()
      const [pending, setPending] = useState(shared.pendingQuote)
      const [pos, setPos] = useState(null) // { left, top, width }
      const inputRef = useRef(input)
      inputRef.current = input

      useEffect(() => {
        shared.onChange = setPending
        shared.inputActions = inputActions
        shared.input = input

        // Harden the submit interception so it can never break sending:
        // defineProperty (avoids strict-mode errors on read-only props), a
        // fully contained try/catch, and a phase guard that only injects while
        // the input is idle ('plain').
        let wrapped = false
        let orig = null
        try {
          orig = typeof inputActions.submit === 'function' ? inputActions.submit : null
          if (orig) {
            const wrapper = function (...args) {
              const q = shared.pendingQuote
              if (q) {
                try {
                  const st = inputRef.current
                  if (!st || st.phase === 'plain') {
                    const cur = (st && st.draft) || ''
                    inputActions.setDraft(composeDraft(buildQuote(q.text), cur))
                  }
                } catch {
                  /* injection failure must never break sending */
                }
                setPendingQuote(null)
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
          /* interception unavailable; card still displays, send unaffected */
        }

        return () => {
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
            border: '1px solid ' + t.border,
            background: t.bg,
            color: t.fg,
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
              background: t.pillBg,
              color: t.muted,
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
              color: t.muted,
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
              marginTop: '1px',
              border: 'none',
              background: 'transparent',
              color: t.muted,
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
      const t = useResolvedTheme()
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
            border: '1px solid ' + t.border,
            background: t.bg,
            color: t.muted,
            fontSize: '12px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
        '引用',
      )
    }

    function apply(ctx) {
      // Follow the DSH theme service so the card colors track light/dark
      // switches at runtime (plus a MutationObserver fallback on <html>).
      try {
        const themeSvc = ctx.get('theme')
        if (themeSvc && typeof themeSvc.subscribe === 'function') {
          ctx.effect(() => themeSvc.subscribe(() => refreshTheme()))
        }
      } catch {
        /* ignore */
      }
      try {
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
          const ob = new MutationObserver(refreshTheme)
          ob.observe(document.documentElement, { attributes: true })
          ctx.effect(() => () => ob.disconnect())
        }
      } catch {
        /* ignore */
      }

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

      // 2) Quote chip inside the input box + session bridge (session scope).
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
