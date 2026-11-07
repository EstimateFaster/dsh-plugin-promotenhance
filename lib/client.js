/**
 * Client half of the prompt-enhance bundle (v2).
 *
 * 右侧栏 page tab：面板自己维护提问卡片与结果预览，状态来自宿主内存
 * （GET /prompt-enhance/state）。插入通过 inputActions.setDraft() 写回目标会话，
 * 拿不到 inputActions 时退回隐藏桥。
 *
 * 样式只用 DSH 的设计变量（--dsw-alias-*、--dsw-radius-*、--dsh-content-font-size），
 * 不写死颜色，自动跟随明暗主题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'promptEnhance'
    const TAB_ID = 'dsh-prompt-enhance'
    const KIND = 'promptenhance'
    const BASE = '/prompt-enhance'
    const BRIDGE_ID = 'dsh-prompt-enhance-bridge'

    // ───────────────────────────── 文案 ─────────────────────────────

    const zh = {
      'tab.title': '提示词增强',
      'guide.title': '提示词增强',
      'guide.description': '把粗糙提示词问清楚，再写回输入框',
      'empty.title': '还没有增强任务',
      'empty.hint': '在输入框输入 /enhance 加一句粗糙需求，再回到这里',
      'phase.collecting': '正在理解上下文…',
      'phase.drafting': '正在起草提示词…',
      'phase.questioning': '需要你确认几个点',
      'phase.ready': '提示词已就绪',
      'phase.failed': '生成失败',
      'phase.cancelled': '已取消',
      'phase.expired': '已过期',
      'action.cancel': '取消',
      'action.retry': '重试',
      'action.insert': '插入到输入框',
      'action.copy': '复制',
      'action.regenerate': '重新生成',
      'action.skip': '跳过',
      'action.next': '下一题',
      'action.prev': '上一题',
      'action.submit': '提交',
      'hint.inserted': '已插入到输入框',
      'hint.insertFailed': '插入失败，请重试',
      'hint.assumptions': '关键假设（不会插入）',
      'hint.editable': '可以直接改，插入的是改后的版本',
      'hint.copied': '已复制',
      'hint.custom': '补充说明（可选）',
      'hint.recommended': '推荐',
      'hint.noRun': '任务已失效（宿主可能重启过），请重新 /enhance',
      'mark.enhancing': '提示词增强中',
      'mark.used': '已使用提示词增强',
      'error.NO_RUN': '增强任务不存在或已过期',
      'error.NO_SEED': '没有可继续的任务，请重新 /enhance',
      'error.STALE_BATCH': '这批问题已经被回答',
      'error.LLM_FAILED': '模型调用失败',
      'error.INVALID_MODEL_OUTPUT': '模型输出不合法',
      'error.NOT_READY': '提示词还没生成完',
      'error.BODY_TOO_LARGE': '提交内容太大',
      'error.NETWORK': '连接宿主失败',
    }

    const en = {
      'tab.title': 'Enhance',
      'guide.title': 'Prompt enhance',
      'guide.description': 'Clarify a rough prompt, then insert it',
      'empty.title': 'No enhancement yet',
      'empty.hint': 'Type /enhance with a rough prompt in the composer, then come back here',
      'phase.collecting': 'Reading the context…',
      'phase.drafting': 'Drafting the prompt…',
      'phase.questioning': 'A few questions',
      'phase.ready': 'Prompt ready',
      'phase.failed': 'Generation failed',
      'phase.cancelled': 'Cancelled',
      'phase.expired': 'Expired',
      'action.cancel': 'Cancel',
      'action.retry': 'Retry',
      'action.insert': 'Insert',
      'action.copy': 'Copy',
      'action.regenerate': 'Redo',
      'action.skip': 'Skip',
      'action.next': 'Next',
      'action.prev': 'Back',
      'action.submit': 'Submit',
      'hint.inserted': 'Inserted into the composer',
      'hint.insertFailed': 'Insert failed, try again',
      'hint.assumptions': 'Key assumptions (not inserted)',
      'hint.editable': 'Edit here; the edited version gets inserted',
      'hint.copied': 'Copied',
      'hint.custom': 'Extra notes (optional)',
      'hint.recommended': 'Suggested',
      'hint.noRun': 'The task expired (the host may have restarted). Run /enhance again.',
      'mark.enhancing': 'Prompt enhancement running',
      'mark.used': 'Enhanced prompt ready',
      'error.NO_RUN': 'No enhancement task',
      'error.NO_SEED': 'Nothing to continue — run /enhance again',
      'error.STALE_BATCH': 'This batch was already answered',
      'error.LLM_FAILED': 'Model call failed',
      'error.INVALID_MODEL_OUTPUT': 'The model returned an invalid response',
      'error.NOT_READY': 'The prompt is not ready yet',
      'error.BODY_TOO_LARGE': 'Payload too large',
      'error.NETWORK': 'Cannot reach the host',
    }

    // ───────────────────────── 通信与插入 ─────────────────────────

    async function api(path, body) {
      try {
        const response =
          body === undefined
            ? await fetch(BASE + path, { headers: { accept: 'application/json' } })
            : await fetch(BASE + path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              })
        const data = await response.json().catch(() => null)
        if (data && typeof data === 'object') return data
        return { ok: false, error: { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` } }
      } catch (error) {
        return { ok: false, error: { code: 'NETWORK', message: String((error && error.message) || error) } }
      }
    }

    const pendingByTarget = new Map()
    const pendingListeners = new Set()
    const enhanceListeners = new Set()

    function requestInsert(sessionId, text) {
      pendingByTarget.set(sessionId, text)
      for (const listener of pendingListeners) {
        try {
          listener()
        } catch (error) {
          console.warn('prompt-enhance: pending insert listener failed', error)
        }
      }
    }

    function consumeInsert(sessionId) {
      const text = pendingByTarget.get(sessionId)
      if (text !== undefined) pendingByTarget.delete(sessionId)
      return text
    }

    // 侧栏角标状态：sessionId → 'enhancing' | 'used'
    const sessionStatus = new Map()
    const statusListeners = new Set()

    function setSessionStatuses(next) {
      sessionStatus.clear()
      for (const [id, value] of Object.entries(next || {})) sessionStatus.set(id, value)
      for (const listener of statusListeners) {
        try {
          listener()
        } catch (error) {
          console.warn('prompt-enhance: status listener failed', error)
        }
      }
    }

    function subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => {
        statusListeners.delete(listener)
      }
    }

    /** 新的 /enhance 到达时通知已打开的面板重新拉取任务。 */
    function requestEnhance(sessionId) {
      for (const listener of enhanceListeners) {
        try {
          listener(sessionId)
        } catch (error) {
          console.warn('prompt-enhance: enhance listener failed', error)
        }
      }
    }

    // ───────────────────── 样式：只用 DSH 设计变量 ─────────────────────

    const CSS = [
      '.pe-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:22px;}',
      '.pe-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:14px;overflow:auto;}',
      '.pe-body[data-fill="1"]{overflow:auto;}',
      '.pe-body[data-center="1"]{align-items:center;justify-content:center;text-align:center;}',
      '.pe-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);}',
      '.pe-card-quiet{background:transparent;border-color:var(--dsw-alias-border-l1);}',
      '.pe-qh{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.pe-q{font-size:var(--dsh-content-font-size,14px);line-height:22px;}',
      '.pe-opt{box-sizing:border-box;display:flex;align-items:flex-start;gap:10px;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease;}',
      '.pe-opt:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.pe-opt:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary);}',
      '.pe-opt[data-on="1"]{background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,var(--dsw-alias-border-l3));}',
      '.pe-dot{position:relative;flex:none;width:16px;height:16px;margin-top:3px;border:1.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));border-radius:50%;}',
      '.pe-opt[data-on="1"] .pe-dot{border-color:var(--dsw-alias-brand-primary);}',
      '.pe-opt[data-on="1"] .pe-dot:after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--dsw-alias-brand-primary);}',
      '.pe-olabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:var(--dsh-content-font-size,14px);line-height:22px;}',
      '.pe-odetail{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.pe-badge{flex:none;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}',
      '.pe-textarea{box-sizing:border-box;width:100%;flex:1 1 240px;min-height:240px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.7;resize:none;outline:none;}',
      '.pe-textarea:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.pe-input{box-sizing:border-box;width:100%;min-height:64px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;resize:vertical;outline:none;}',
      '.pe-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.pe-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.pe-spacer{flex:1;}',
      '.pe-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}',
      '.pe-btn:disabled{opacity:.4;cursor:default;}',
      '.pe-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.pe-btn-outline{border:.5px solid var(--dsw-alias-border-l3);}',
      '.pe-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.pe-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.pe-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
      '.pe-chip{display:inline-flex;align-items:center;flex:none;height:24px;padding:0 8px;border-radius:999px;font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}',
      '.pe-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l1);}',
      '.pe-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.pe-note[data-tone="warn"]{color:var(--dsw-alias-state-error-primary);}',
      '.pe-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}',
      '.pe-assume{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.pe-assume-item{display:flex;gap:6px;}',
      '.pe-assume-item:before{content:"·";}',
      '.pe-empty{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:280px;}',
      '.pe-empty-title{font-size:14px;line-height:22px;font-weight:600;}',
      '.pe-empty-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.pe-mark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;}',
      '.pe-mark:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);}',
      '.pe-mark[data-state="enhancing"]:before{animation:pe-blink 1.6s ease-in-out infinite;}',
      '.pe-mark[data-state="used"]:before{background:var(--dsw-alias-state-success-primary);}',
      '@keyframes pe-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '.pe-skel{height:10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);animation:pe-pulse 1.4s ease-in-out infinite;}',
      '@keyframes pe-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
    ].join('\n')

    // ───────────────────────── 问题卡片 ─────────────────────────

    function QuestionCard({ questions, onSubmit, t, busy }) {
      const [index, setIndex] = React.useState(0)
      const [answers, setAnswers] = React.useState(() => {
        const initial = {}
        for (const question of questions) {
          const recommended = question.multiSelect ? [] : question.options.filter((o) => o.recommended).slice(0, 1).map((o) => o.id)
          initial[question.id] = { selected: recommended, custom: '', skipped: false }
        }
        return initial
      })

      const question = questions[index]
      const current = answers[question.id] || { selected: [], custom: '', skipped: false }
      const last = index === questions.length - 1
      const answered = current.skipped || current.selected.length > 0 || current.custom.trim().length > 0

      const patch = (next) => setAnswers((prev) => ({ ...prev, [question.id]: { ...prev[question.id], ...next } }))

      const toggle = (optionId) => {
        if (question.multiSelect) {
          const selected = current.selected.includes(optionId)
            ? current.selected.filter((id) => id !== optionId)
            : [...current.selected, optionId]
          patch({ selected, skipped: false })
        } else {
          patch({ selected: [optionId], skipped: false })
        }
      }

      const submit = (overrides = {}) => {
        const merged = (id) => ({ ...(answers[id] || {}), ...(overrides[id] || {}) })
        onSubmit(
          questions.map((item) => ({
            questionId: item.id,
            selected: merged(item.id).selected || [],
            custom: (merged(item.id).custom || '').trim() || null,
            skipped: Boolean(merged(item.id).skipped),
          })),
        )
      }

      return h(
        'div',
        { className: 'pe-card' },
        h(
          'div',
          { className: 'pe-qh' },
          h('span', null, question.header || t('phase.questioning', 'A few questions')),
          h('span', null, `${index + 1} / ${questions.length}`),
        ),
        h('div', { className: 'pe-q' }, question.question),
        ...question.options.map((option) =>
          h(
            'button',
            {
              key: option.id,
              type: 'button',
              className: 'pe-opt',
              'data-on': current.selected.includes(option.id) ? '1' : '0',
              onClick: () => toggle(option.id),
            },
            h('span', { className: 'pe-dot' }),
            h(
              'span',
              null,
              h(
                'span',
                { className: 'pe-olabel' },
                h('span', null, option.label),
                option.recommended ? h('span', { className: 'pe-badge' }, t('hint.recommended', 'Suggested')) : null,
              ),
              option.detail ? h('div', { className: 'pe-odetail' }, option.detail) : null,
            ),
          ),
        ),
        question.allowCustom
          ? h('textarea', {
              className: 'pe-input',
              placeholder: t('hint.custom', 'Extra notes (optional)'),
              value: current.custom,
              onChange: (event) => patch({ custom: event.target.value, skipped: false }),
            })
          : null,
        h(
          'div',
          { className: 'pe-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'pe-btn pe-btn-ghost',
              onClick: () => {
                patch({ skipped: true })
                if (last) submit({ [question.id]: { skipped: true } })
                else setIndex(index + 1)
              },
              disabled: busy,
            },
            t('action.skip', 'Skip'),
          ),
          h('span', { className: 'pe-spacer' }),
          index > 0
            ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => setIndex(index - 1), disabled: busy }, t('action.prev', 'Back'))
            : null,
          last
            ? h('button', { type: 'button', className: 'pe-btn pe-btn-primary', onClick: submit, disabled: busy || !answered }, t('action.submit', 'Submit'))
            : h('button', { type: 'button', className: 'pe-btn pe-btn-primary', onClick: () => setIndex(index + 1), disabled: busy || !answered }, t('action.next', 'Next')),
        ),
      )
    }

    // ───────────────────────── 面板 ─────────────────────────

    function Panel({ sessionId, inputActions, t }) {
      const [status, setStatus] = React.useState('loading')
      const [run, setRun] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const failText = React.useCallback(
        (code, message) => {
          const key = `error.${code}`
          const localized = t(key, '')
          return localized && localized !== key ? localized : message || code
        },
        [t],
      )

      const applyResult = React.useCallback((result) => {
        if (result && result.ok && result.state) {
          setRun(result.state)
          setStatus('run')
          setError(null)
          if (result.state.prompt && result.state.prompt.markdown) setDraft(result.state.prompt.markdown)
          return true
        }
        const err = (result && result.error) || { code: 'NETWORK', message: '' }
        setError(err)
        setStatus(err.code === 'NO_RUN' || err.code === 'NO_SEED' ? 'empty' : 'error')
        return false
      }, [])

      const refresh = React.useCallback(async () => {
        const result = await api(`/state?session=${encodeURIComponent(sessionId)}`)
        if (result.ok && result.state) {
          setRun(result.state)
          setStatus('run')
          setError(null)
          setDraft((prev) => {
            if (!result.state.prompt) return prev
            if (prev && prev.trim() && prev !== result.state.prompt.markdown) return prev
            return result.state.prompt.markdown
          })
        } else if (result.error && result.error.code === 'NO_RUN') {
          setStatus('empty')
          setRun(null)
        }
      }, [sessionId])

      const start = React.useCallback(
        async (restart) => {
          const result = await api('/start', { session: sessionId, ...(restart ? { restart: true } : {}) })
          applyResult(result)
        },
        [sessionId, applyResult],
      )

      React.useEffect(() => {
        setStatus('loading')
        start(false).catch(() => setStatus('error'))
      }, [start])

      React.useEffect(() => {
        const listener = (id) => {
          if (id !== sessionId) return
          setStatus('loading')
          start(false).catch(() => setStatus('error'))
        }
        enhanceListeners.add(listener)
        return () => {
          enhanceListeners.delete(listener)
        }
      }, [sessionId, start])

      const phase = run && run.phase
      React.useEffect(() => {
        if (phase !== 'collecting' && phase !== 'drafting') return undefined
        const timer = setInterval(() => {
          refresh().catch(() => {})
        }, 700)
        return () => clearInterval(timer)
      }, [phase, refresh])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 2400)
        return () => clearTimeout(timer)
      }, [notice])

      const runAction = async (path, body) => {
        setBusy(true)
        try {
          const result = await api(path, { session: sessionId, ...body })
          applyResult(result)
          return result
        } finally {
          setBusy(false)
        }
      }

      const insert = async () => {
        if (!run || !run.prompt) return
        const text = draft.trim() || run.prompt.markdown
        let wrote = false
        if (inputActions && typeof inputActions.setDraft === 'function') {
          try {
            inputActions.setDraft(text)
            if (typeof inputActions.focus === 'function') inputActions.focus()
            wrote = true
          } catch (error) {
            console.warn('prompt-enhance: setDraft failed', error)
          }
        }
        if (!wrote) requestInsert(sessionId, text)
        await runAction('/take', { runId: run.runId, markdown: text })
        setNotice(wrote ? t('hint.inserted', 'Inserted into the composer') : t('hint.insertFailed', 'Insert failed, try again'))
      }

      const copy = async () => {
        const text = draft.trim() || (run && run.prompt && run.prompt.markdown) || ''
        try {
          await navigator.clipboard.writeText(text)
          setNotice(t('hint.copied', 'Copied'))
        } catch {
          setNotice(t('hint.insertFailed', 'Insert failed, try again'))
        }
      }

      const phaseLabel = (() => {
        switch (phase) {
          case 'collecting':
            return t('phase.collecting', 'Reading the context…')
          case 'drafting':
            return t('phase.drafting', 'Drafting the prompt…')
          case 'questioning':
            return t('phase.questioning', 'A few questions')
          case 'ready':
            return t('phase.ready', 'Prompt ready')
          case 'inserted':
            return t('hint.inserted', 'Inserted into the composer')
          case 'cancelled':
            return t('phase.cancelled', 'Cancelled')
          case 'failed':
            return t('phase.failed', 'Generation failed')
          default:
            return t('phase.expired', 'Expired')
        }
      })()

      if (status === 'empty') {
        return h(
          'div',
          { className: 'pe-root' },
          h(
            'div',
            { className: 'pe-body', 'data-center': '1' },
            h(
              'div',
              { className: 'pe-empty' },
              h('div', { className: 'pe-empty-title' }, t('empty.title', 'No enhancement yet')),
              h('div', { className: 'pe-empty-hint' }, t('empty.hint', 'Type /enhance with a rough prompt in the composer, then come back here')),
              error && error.code === 'NO_RUN' ? h('div', { className: 'pe-note', 'data-tone': 'warn' }, t('hint.noRun', 'The task expired. Run /enhance again.')) : null,
            ),
          ),
        )
      }

      if (status === 'loading') {
        return h(
          'div',
          { className: 'pe-root' },
          h(
            'div',
            { className: 'pe-body' },
            h(
              'div',
              { className: 'pe-card pe-card-quiet' },
              h('div', { className: 'pe-note' }, t('phase.collecting', 'Reading the context…')),
              h('div', { className: 'pe-skel', style: { width: '60%' } }),
              h('div', { className: 'pe-skel', style: { width: '85%' } }),
              h('div', { className: 'pe-skel', style: { width: '45%' } }),
            ),
          ),
        )
      }

      if (status === 'error') {
        return h(
          'div',
          { className: 'pe-root' },
          h(
            'div',
            { className: 'pe-body', 'data-center': '1' },
            h(
              'div',
              { className: 'pe-empty' },
              h('div', { className: 'pe-note', 'data-tone': 'warn' }, failText(error && error.code, error && error.message)),
              h('button', { type: 'button', className: 'pe-btn pe-btn-outline', onClick: () => { setStatus('loading'); start(false) }, disabled: busy }, t('action.retry', 'Retry')),
            ),
          ),
        )
      }

      const busyPhase = phase === 'collecting' || phase === 'drafting'
      const resultable = (phase === 'ready' || phase === 'inserted') && Boolean(run.prompt)

      return h(
        'div',
        { className: 'pe-root' },
        h(
          'div',
          { className: 'pe-body', 'data-fill': resultable ? '1' : '0' },
          busyPhase
            ? h(
                'div',
                { className: 'pe-card pe-card-quiet' },
                h('div', { className: 'pe-note' }, phaseLabel),
                h('div', { className: 'pe-skel', style: { width: '55%' } }),
                h('div', { className: 'pe-skel', style: { width: '80%' } }),
                h('div', { className: 'pe-skel', style: { width: '40%' } }),
              )
            : null,
          phase === 'questioning' && run.questions
            ? h(QuestionCard, {
                key: run.questions.batchId,
                questions: run.questions.questions,
                t,
                busy,
                onSubmit: (answers) => runAction('/answer', { runId: run.runId, batchId: run.questions.batchId, answers }),
              })
            : null,
          resultable
            ? h(
                React.Fragment,
                null,
                h('div', { className: 'pe-note' }, t('hint.editable', 'Edit here; the edited version gets inserted')),
                h('textarea', { className: 'pe-textarea', value: draft, onChange: (event) => setDraft(event.target.value) }),
                run.prompt.assumptions && run.prompt.assumptions.length
                  ? h(
                      'div',
                      { className: 'pe-assume' },
                      h('div', { className: 'pe-note' }, t('hint.assumptions', 'Key assumptions (not inserted)')),
                      ...run.prompt.assumptions.map((item, index) => h('div', { key: index, className: 'pe-assume-item' }, h('span', null, item))),
                    )
                  : null,
              )
            : null,
          phase === 'failed'
            ? h(
                'div',
                { className: 'pe-card pe-card-quiet' },
                h('div', { className: 'pe-note', 'data-tone': 'warn' }, failText(run.error && run.error.code, run.error && run.error.message)),
                h('div', { className: 'pe-actions' }, h('button', { type: 'button', className: 'pe-btn pe-btn-outline', onClick: () => runAction('/start', { restart: true }), disabled: busy }, t('action.retry', 'Retry'))),
              )
            : null,
          phase === 'cancelled' || phase === 'expired'
            ? h(
                'div',
                { className: 'pe-card pe-card-quiet' },
                h('div', { className: 'pe-note' }, phase === 'cancelled' ? t('phase.cancelled', 'Cancelled') : t('hint.noRun', 'The task expired. Run /enhance again.')),
                h('div', { className: 'pe-actions' }, h('button', { type: 'button', className: 'pe-btn pe-btn-outline', onClick: () => runAction('/start', { restart: true }), disabled: busy }, t('action.regenerate', 'Regenerate'))),
              )
            : null,
        ),
        h(
          'div',
          { className: 'pe-foot' },
          h('span', { className: 'pe-chip' }, phaseLabel),
          h('span', { className: 'pe-spacer' }),
          notice ? h('span', { className: 'pe-note', 'data-tone': 'ok' }, notice) : null,
          busyPhase || phase === 'questioning'
            ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => runAction('/cancel', { runId: run.runId }), disabled: busy }, t('action.cancel', 'Cancel'))
            : null,
          resultable
            ? h(
                React.Fragment,
                null,
                h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: copy, disabled: busy }, t('action.copy', 'Copy')),
                h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => runAction('/start', { restart: true }), disabled: busy }, t('action.regenerate', 'Regenerate')),
                h('button', { type: 'button', className: 'pe-btn pe-btn-primary', onClick: insert, disabled: busy }, t('action.insert', 'Insert')),
              )
            : null,
        ),
      )
    }

    // ───────────────────────── 注册 ─────────────────────────

    /** 侧栏「开始」页的入口图标（currentColor，跟随主题）。 */
    function PromptEnhanceGlyph({ size = 24, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4.5 19.5 L14 10' }),
        h('path', { d: 'M16.5 3.5 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2 z' }),
        h('path', { d: 'M19.5 14 l.7 1.8 1.8.7 -1.8.7 -.7 1.8 -.7-1.8 -1.8-.7 1.8-.7 z' }),
      )
    }


    function InsertBridge({ sessionId, inputActions }) {
      React.useEffect(() => {
        if (!sessionId) return undefined
        const apply = () => {
          const text = consumeInsert(sessionId)
          if (text === undefined) return
          if (inputActions && typeof inputActions.setDraft === 'function') {
            try {
              inputActions.setDraft(text)
              if (typeof inputActions.focus === 'function') inputActions.focus()
            } catch (error) {
              console.warn('prompt-enhance: bridge setDraft failed', error)
            }
          } else {
            pendingByTarget.set(sessionId, text)
          }
        }
        apply()
        pendingListeners.add(apply)
        return () => {
          pendingListeners.delete(apply)
        }
      }, [sessionId, inputActions])
      return null
    }

    const inject = ['slots', 'locale', 'sidebarRight']

    function apply(ctx) {
      ctx.effect(
        () => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-prompt-enhance'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        },
        'prompt-enhance: styles',
      )

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-enhance: dictionaries')

      const t = (key, fallback) => {
        try {
          const value = ctx.locale.bind(NS)(key)
          return value && value !== key ? value : fallback !== undefined ? fallback : key
        } catch {
          return fallback !== undefined ? fallback : key
        }
      }

      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(
          () =>
            scope.sidebarRightTabs.register({
              id: TAB_ID,
              kind: KIND,
              multiple: false,
              priority: 'extension',
              title: () => t('tab.title', 'Enhance'),
              guide: [
                {
                  id: 'prompt-enhance',
                  order: 30,
                  title: () => t('guide.title', 'Prompt enhance'),
                  description: () => t('guide.description', 'Clarify a rough prompt, then insert it'),
                  icon: PromptEnhanceGlyph,
                },
              ],
            }),
          'prompt-enhance: tab type',
        )

        scope.effect(
          () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) =>
              h(Panel, { sessionId: props.sessionId, inputActions: props.inputActions, t }),
            ),
          'prompt-enhance: tab body',
        )
      })

      ctx.effect(
        () =>
          ctx.on('command/executed', (sessionId, name, result) => {
            if (name !== 'enhance' || !result || result.kind !== 'success') return
            requestEnhance(sessionId)
            try {
              ctx.sidebarRight.openTab(KIND)
            } catch (error) {
              console.warn('prompt-enhance: openTab failed', error)
            }
          }),
        'prompt-enhance: command bridge',
      )

      const EnhanceMark = function PromptEnhanceMark({ sessionId }) {
        const status = React.useSyncExternalStore(subscribeStatus, () => sessionStatus.get(sessionId) || null)
        if (!status) return null
        const label = status === 'enhancing' ? t('mark.enhancing', 'Prompt enhancement running') : t('mark.used', 'Enhanced prompt ready')
        return h('span', { className: 'pe-mark', 'data-state': status, title: label, 'aria-label': label, role: 'img' })
      }

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.session.row.leading', () =>
            ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'dsh-prompt-enhance-mark', order: 10 }, EnhanceMark),
          ),
        'prompt-enhance: session row mark',
      )

      ctx.effect(() => {
        let stopped = false
        const tick = async () => {
          try {
            const response = await fetch(BASE + '/sessions', { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => null)
            if (!stopped && data && data.ok && data.sessions) setSessionStatuses(data.sessions)
          } catch {
            /* 宿主不在时静默 */
          }
        }
        tick()
        const timer = setInterval(tick, 2000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, 'prompt-enhance: sidebar marks poller')

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register({ name: 'conversation.input.dock', id: BRIDGE_ID, order: 90 }, InsertBridge),
          ),
        'prompt-enhance: composer bridge',
      )
    }

    return { inject, apply }
  },
})
