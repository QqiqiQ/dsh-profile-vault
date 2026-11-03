/**
 * dsh-profile-vault — 设置页「个人资料」面板(Client 半边)。
 *
 * 以 dsh.client bundle 格式加载:注册 settings.section 一页,左列是人物索引,
 * 右列是这个人已存的条目(可改、可加、可删、可看历史)。数据全部走插件的
 * 同源 HTTP 路由(/profile-vault/query、/profile-vault/write),与 AI 工具用
 * 同一套 vault 校验,所以面板写进去的东西工具读得到、反过来也一样。
 *
 * 授权只管 AI:面板是用户本人当面翻自己的资料,不再弹授权卡。
 * 注册 id 必须等于 loader entry 名(dsh-profile-vault)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-vault',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STYLE_OWNER_ID = 'dsh-profile-vault'
    const QUERY_PATH = '/profile-vault/query'
    const WRITE_PATH = '/profile-vault/write'

    const CSS = [
      '.pv-root{display:flex;flex-direction:column;gap:12px;padding:2px 0 10px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.pv-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.pv-title{font-size:16px;font-weight:600;line-height:1.4}',
      '.pv-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pv-muted{color:var(--dsw-alias-label-secondary)}',
      '.pv-notice{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;line-height:1.5}',
      '.pv-error{font-size:12px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-danger-primary,#e5484d) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-danger-primary,#e5484d) 45%,transparent);border-radius:8px;padding:7px 10px}',
      '.pv-grid{display:grid;grid-template-columns:minmax(180px,250px) minmax(0,1fr);gap:14px;align-items:start}',
      '@media (max-width:820px){.pv-grid{grid-template-columns:1fr}}',
      '.pv-pane{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}',
      '.pv-pane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pv-people{display:flex;flex-direction:column;gap:2px;padding:5px;max-height:470px;overflow:auto}',
      '.pv-person{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:none;background:transparent;color:inherit;padding:7px 9px;border-radius:8px;cursor:pointer;font:inherit}',
      '.pv-person:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.pv-person.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.pv-person-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pv-person-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pv-body{display:flex;flex-direction:column;gap:12px;padding:12px}',
      '.pv-person-head{display:flex;flex-direction:column;gap:8px;padding-bottom:10px;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.pv-person-fields{display:flex;gap:8px;flex-wrap:wrap}',
      '.pv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.pv-spacer{flex:1}',
      '.pv-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pv-grow{flex:1;min-width:130px}',
      '.pv-root input[type=text],.pv-root input:not([type]),.pv-root input[type=date],.pv-root textarea{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;font-size:13px;font-family:inherit;outline:none;min-width:0}',
      '.pv-root input:focus,.pv-root textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.pv-root input:disabled{opacity:.6}',
      '.pv-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 11px;font-size:12px;font-family:inherit;cursor:pointer;transition:border-color .12s ease,background .12s ease;white-space:nowrap}',
      '.pv-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.pv-btn:disabled{opacity:.45;cursor:default}',
      '.pv-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.pv-btn-primary:hover:not(:disabled){filter:brightness(1.06)}',
      '.pv-btn-ghost{background:transparent}',
      '.pv-btn-danger{color:var(--dsw-alias-danger-primary,#e5484d)}',
      '.pv-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-danger-primary,#e5484d)}',
      '.pv-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 6px 2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.pv-chip-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1;padding:0 1px}',
      '.pv-chip-x:hover{color:var(--dsw-alias-danger-primary,#e5484d)}',
      '.pv-alias-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.pv-alias-input{width:110px}',
      '.pv-entries{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:10px}',
      '.pv-entry{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;display:flex;flex-direction:column;gap:6px}',
      '.pv-entry.is-sensitive{border-color:color-mix(in srgb,var(--dsw-alias-danger-primary,#e5484d) 45%,var(--dsw-alias-border-l1))}',
      '.pv-entry-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.pv-entry-label{font-weight:600}',
      '.pv-badge{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.pv-badge-warn{color:var(--dsw-alias-danger-primary,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-danger-primary,#e5484d) 45%,transparent)}',
      '.pv-entry-value{font-size:15px;line-height:1.35;word-break:break-all}',
      '.pv-entry-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pv-computed{font-size:12px;color:var(--dsw-alias-brand-primary)}',
      '.pv-warnings{margin:0;padding-left:16px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.pv-entry-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
      '.pv-history{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px}',
      '.pv-history-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pv-history-value{color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.pv-form{display:flex;flex-direction:column;gap:8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;padding:10px}',
      '.pv-form-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}',
      '.pv-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pv-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.pv-empty{padding:26px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}',
      '.pv-grants{padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.pv-grant{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px}',
      '.pv-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:80;padding:20px}',
      '.pv-modal{width:min(420px,100%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 18px 50px rgba(0,0,0,.3)}',
      '.pv-modal-title{font-size:14px;font-weight:600}',
      '.pv-modal-text{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.pv-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      '.pv-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 30px rgba(0,0,0,.25);font-size:12px;color:var(--dsw-alias-label-primary)}',
    ].join('\n')

    /**
     * 归属本插件的 <style>:不加 data-plugin 的标签会被宿主的模块系统认领,
     * 之后随别的模块一起被删掉(设置页样式突然全没,重启才好)。
     */
    function createOwnedStyle(css) {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', STYLE_OWNER_ID)
      el.textContent = css
      document.head.appendChild(el)
      return el
    }

    async function requestJson(path, payload) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        })
      } catch {
        const error = new Error('连不上宿主（网络错误），稍后再试。')
        error.code = 'network'
        throw error
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const info = body?.error ?? {}
        const error = new Error(info.message ?? `请求失败（HTTP ${response.status}）`)
        error.code = info.code ?? 'http'
        error.info = info
        throw error
      }
      return body
    }

    function formatDay(iso) {
      return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : ''
    }

    function formatStamp(iso) {
      return typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : ''
    }

    function todayInput() {
      const now = new Date()
      return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    }

    const CONFIDENCE = { inferred: '推断', imported: '导入' }
    const SOURCE = { tool: 'AI', panel: '设置页', import: '导入' }

    function valueText(entry) {
      if (entry.current === null || entry.current === undefined) return ''
      const value = entry.current.value
      if (entry.kind === 'bool') return value === true ? '是' : '否'
      if (Array.isArray(value)) return value.join('、')
      return String(value)
    }

    function observationText(entry, observation) {
      if (entry.kind === 'bool') return observation.value === true ? '是' : '否'
      if (Array.isArray(observation.value)) return observation.value.join('、')
      return String(observation.value)
    }

    function computedText(entry) {
      const computed = entry.computed
      if (computed === undefined || computed === null) return null
      const parts = []
      if (computed.ageYears !== undefined) parts.push(`${computed.ageYears} 岁${computed.approximate === true ? '（近似）' : ''}`)
      if (computed.nextOccurrence !== undefined) {
        const next = computed.nextOccurrence
        const when = next.inDays === 0 ? '就是今天' : next.inDays === 1 ? '明天' : `还有 ${next.inDays} 天`
        parts.push(
          computed.ageYears === undefined
            ? `下次 ${next.date}（${when}）`
            : `下次生日 ${next.date}（${when}，届时 ${next.turningAge} 岁）`,
        )
      }
      return parts.length === 0 ? null : `现算：${parts.join('；')}`
    }

    function EntryCard({ entry, expanded, onEdit, onDelete, onDeleteObservation, onToggleHistory }) {
      const computed = computedText(entry)
      const head = h(
        'div',
        { className: 'pv-entry-head' },
        h('span', { className: 'pv-entry-label' }, entry.label),
        entry.tier === 'sensitive' ? h('span', { className: 'pv-badge pv-badge-warn' }, '身份类') : null,
        entry.stability === 'volatile' ? h('span', { className: 'pv-badge' }, '易变') : null,
        entry.key.startsWith('x_') ? h('span', { className: 'pv-badge' }, '自定义') : null,
      )

      const meta = h(
        'div',
        { className: 'pv-entry-meta' },
        h('span', null, entry.current === null ? '没有观测' : `观测于 ${formatDay(entry.current.observedAt)}`),
        entry.current?.confidence && entry.current.confidence !== 'stated'
          ? h('span', null, CONFIDENCE[entry.current.confidence] ?? entry.current.confidence)
          : null,
        entry.observations > 1 ? h('span', null, `${entry.observations} 条有效观测`) : null,
        entry.current?.ageDays > 0 ? h('span', null, `${entry.current.ageDays} 天前` ) : null,
      )

      return h(
        'div',
        { className: 'pv-entry' + (entry.tier === 'sensitive' ? ' is-sensitive' : '') },
        head,
        h('div', { className: 'pv-entry-value' }, entry.current === null ? h('span', { className: 'pv-muted' }, '（空）') : valueText(entry)),
        meta,
        computed === null ? null : h('div', { className: 'pv-computed' }, computed),
        (entry.warnings ?? []).length === 0
          ? null
          : h('ul', { className: 'pv-warnings' }, entry.warnings.map((warning, index) => h('li', { key: index }, warning))),
        h(
          'div',
          { className: 'pv-entry-actions' },
          h('button', { className: 'pv-btn pv-btn-ghost', onClick: () => onEdit(entry) }, '改值'),
          entry.history.length > 0
            ? h('button', { className: 'pv-btn pv-btn-ghost', onClick: () => onToggleHistory(entry.key) }, expanded ? '收起历史' : `历史 ${entry.history.length}`)
            : null,
          h('button', { className: 'pv-btn pv-btn-ghost pv-btn-danger', onClick: () => onDelete(entry) }, '删条目'),
        ),
        expanded
          ? h(
              'div',
              { className: 'pv-history' },
              entry.history.map((observation) =>
                h(
                  'div',
                  { key: observation.id, className: 'pv-history-row' },
                  h('span', { className: 'pv-history-value' }, observationText(entry, observation)),
                  h(
                    'span',
                    null,
                    `${formatStamp(observation.observedAt)} · ${SOURCE[observation.source] ?? observation.source}${
                      observation.supersededAt === null ? '' : ' · 已被取代'
                    }`,
                  ),
                  observation.supersededAt === null && entry.observations > 1
                    ? h(
                        'button',
                        { className: 'pv-btn pv-btn-ghost pv-btn-danger', onClick: () => onDeleteObservation(entry, observation) },
                        '删除',
                      )
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    function EntryForm({ draft, catalog, busy, editing, onChange, onCancel, onSubmit }) {
      const set = (key) => (value) => onChange({ ...draft, [key]: value })
      const ready = String(draft.entryKey).trim() !== '' && String(draft.value).trim() !== ''
      return h(
        'div',
        { className: 'pv-form' },
        h(
          'div',
          { className: 'pv-form-row' },
          h(
            'label',
            { className: 'pv-field' },
            h('span', null, '条目'),
            h('input', {
              list: 'pv-entry-keys',
              value: draft.entryKey,
              disabled: editing,
              placeholder: '生日 / 鞋码 / 咖啡口味…',
              onChange: (event) => set('entryKey')(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'pv-field pv-grow' },
            h('span', null, '值'),
            h('input', {
              value: draft.value,
              placeholder: draft.entryKey === 'birthday' ? '1990-05-12' : '',
              onChange: (event) => set('value')(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'pv-field' },
            h('span', null, '这条信息的时间'),
            h('input', { type: 'date', value: draft.observedAt, onChange: (event) => set('observedAt')(event.target.value) }),
          ),
        ),
        h(
          'datalist',
          { id: 'pv-entry-keys' },
          catalog.map((item) => h('option', { key: item.key, value: item.label })),
        ),
        h(
          'div',
          { className: 'pv-form-row' },
          h(
            'label',
            { className: 'pv-check' },
            h('input', { type: 'checkbox', checked: draft.last4, onChange: (event) => set('last4')(event.target.checked) }),
            '只存后四位',
          ),
          h(
            'label',
            { className: 'pv-check' },
            h('input', { type: 'checkbox', checked: draft.identity, onChange: (event) => set('identity')(event.target.checked) }),
            '标为敏感',
          ),
          h('div', { className: 'pv-spacer' }),
          onCancel === null ? null : h('button', { className: 'pv-btn pv-btn-ghost', onClick: onCancel, disabled: busy }, '取消'),
          h('button', { className: 'pv-btn pv-btn-primary', onClick: onSubmit, disabled: busy || !ready }, editing ? '保存为新值' : '添加'),
        ),
        h('div', { className: 'pv-hint' }, '「这条信息的时间」指这件事成立/发生的时间，不是录入时间：三个月前量的体重就填那天，不填按今天算。'),
      )
    }

    function PersonHeader({ person, busy, onSave }) {
      const [name, setName] = useState(person.displayName)
      const [relation, setRelation] = useState(person.relation ?? '')
      const [alias, setAlias] = useState('')
      useEffect(() => {
        setName(person.displayName)
        setRelation(person.relation ?? '')
      }, [person.personId, person.rev, person.displayName, person.relation])

      const dirty = name !== person.displayName || relation !== (person.relation ?? '')
      const addAlias = () => {
        const value = alias.trim()
        if (value === '') return
        onSave({ addAlias: value })
        setAlias('')
      }

      return h(
        'div',
        { className: 'pv-person-head' },
        h(
          'div',
          { className: 'pv-person-fields' },
          h('label', { className: 'pv-field pv-grow' }, h('span', null, '姓名'), h('input', { value: name, onChange: (event) => setName(event.target.value) })),
          h(
            'label',
            { className: 'pv-field pv-grow' },
            h('span', null, '关系'),
            h('input', { value: relation, placeholder: '母亲 / 同事 / 客户…', onChange: (event) => setRelation(event.target.value) }),
          ),
          dirty
            ? h(
                'button',
                { className: 'pv-btn pv-btn-primary', disabled: busy || name.trim() === '', onClick: () => onSave({ displayName: name.trim(), relation }) },
                '保存',
              )
            : null,
        ),
        h(
          'div',
          { className: 'pv-alias-row' },
          h('span', { className: 'pv-sub' }, '别名'),
          (person.aliases ?? []).length === 0 ? h('span', { className: 'pv-muted' }, '（无）') : null,
          (person.aliases ?? []).map((item) =>
            h(
              'span',
              { key: item, className: 'pv-chip' },
              item,
              h('button', { className: 'pv-chip-x', title: '移除这个别名', disabled: busy, onClick: () => onSave({ removeAlias: item }) }, '×'),
            ),
          ),
          h('input', {
            className: 'pv-alias-input',
            value: alias,
            placeholder: '加别名',
            onChange: (event) => setAlias(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') addAlias()
            },
          }),
          h('button', { className: 'pv-btn pv-btn-ghost', disabled: busy || alias.trim() === '', onClick: addAlias }, '加'),
        ),
      )
    }

    function ConfirmModal({ title, description, requireText, confirmLabel, busy, onCancel, onConfirm }) {
      const [text, setText] = useState('')
      const ready = requireText === undefined || text.trim() === requireText
      return h(
        'div',
        {
          className: 'pv-modal-mask',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'pv-modal' },
          h('div', { className: 'pv-modal-title' }, title),
          h('p', { className: 'pv-modal-text' }, description),
          requireText === undefined
            ? null
            : h(
                'label',
                { className: 'pv-field' },
                h('span', null, `输入「${requireText}」确认`),
                h('input', { value: text, autoFocus: true, onChange: (event) => setText(event.target.value) }),
              ),
          h(
            'div',
            { className: 'pv-modal-actions' },
            h('button', { className: 'pv-btn pv-btn-ghost', onClick: onCancel, disabled: busy }, '取消'),
            h('button', { className: 'pv-btn pv-btn-danger', onClick: onConfirm, disabled: busy || !ready }, confirmLabel ?? '删除'),
          ),
        ),
      )
    }

    function Panel() {
      const [people, setPeople] = useState([])
      const [stats, setStats] = useState(null)
      const [catalog, setCatalog] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [view, setView] = useState(null)
      const [reveal, setReveal] = useState(false)
      const [withHistory, setWithHistory] = useState(false)
      const [expanded, setExpanded] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const [modal, setModal] = useState(null)
      const [search, setSearch] = useState('')
      const [newName, setNewName] = useState('')
      const [creating, setCreating] = useState(false)
      const [grants, setGrants] = useState(null)
      const [showGrants, setShowGrants] = useState(false)
      const toastTimer = useRef(null)

      const flash = useCallback((message, undo) => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        setNotice(message === null ? null : { text: message, undo: undo ?? null })
        if (message !== null) {
          toastTimer.current = setTimeout(() => setNotice(null), 7000)
        }
      }, [])

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      }, [])

      const refreshPeople = useCallback(async () => {
        const result = await requestJson(QUERY_PATH, { op: 'list' })
        setPeople(Array.isArray(result.people) ? result.people : [])
        return result
      }, [])

      const loadPerson = useCallback(async (personId, options) => {
        const result = await requestJson(QUERY_PATH, {
          op: 'person',
          personId,
          reveal: options?.reveal === true,
          history: options?.history === true,
        })
        setView(result.view ?? null)
        return result
      }, [])

      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const [list, meta] = await Promise.all([requestJson(QUERY_PATH, { op: 'list' }), requestJson(QUERY_PATH, { op: 'meta' })])
            if (!alive) return
            setPeople(Array.isArray(list.people) ? list.people : [])
            setStats(meta.stats ?? null)
            setCatalog(Array.isArray(meta.registry) ? meta.registry : [])
          } catch (failure) {
            if (alive) setError(failure.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const select = useCallback(
        async (personId) => {
          setSelectedId(personId)
          setReveal(false)
          setWithHistory(false)
          setExpanded({})
          setDraft(null)
          setError('')
          try {
            await loadPerson(personId, { reveal: false, history: false })
          } catch (failure) {
            setError(failure.message)
          }
        },
        [loadPerson],
      )

      const applyWrite = useCallback(
        async (payload) => {
          setBusy(true)
          setError('')
          try {
            const result = await requestJson(WRITE_PATH, payload)
            if (result?.view) {
              setView(result.view)
              setSelectedId(result.view.person.personId)
            }
            await refreshPeople()
            return result
          } catch (failure) {
            setError(failure.info?.rev === undefined ? failure.message : `${failure.message}（当前版本 ${failure.info.rev}）`)
            throw failure
          } finally {
            setBusy(false)
          }
        },
        [refreshPeople],
      )

      const emptyDraft = useCallback(
        (entryKey) => ({
          entryKey: entryKey ?? '',
          value: '',
          observedAt: todayInput(),
          last4: false,
          identity: false,
        }),
        [],
      )

      const submitDraft = useCallback(async () => {
        if (draft === null || view === null) return
        try {
          const result = await applyWrite({
            op: 'put-entry',
            personId: view.person.personId,
            entryKey: draft.entryKey,
            value: draft.value,
            observedAt: draft.observedAt === '' ? undefined : draft.observedAt,
            valueMode: draft.last4 ? 'last4' : 'full',
            sensitive: draft.identity === true,
            baseRev: view.person.rev,
          })
          setDraft(null)
          flash(`已写入：${result?.entry?.label ?? draft.entryKey}`)
        } catch {
          // applyWrite already surfaced the reason.
        }
      }, [applyWrite, draft, flash, view])

      const savePerson = useCallback(
        async (patch) => {
          if (view === null) return
          try {
            await applyWrite({ op: 'set-person', personId: view.person.personId, baseRev: view.person.rev, ...patch })
            flash('已保存')
          } catch {
            // surfaced
          }
        },
        [applyWrite, flash, view],
      )

      const removeObservation = useCallback(
        async (entry, observation) => {
          if (view === null) return
          try {
            await applyWrite({
              op: 'delete-observation',
              personId: view.person.personId,
              entryKey: entry.key,
              observationId: observation.id,
              baseRev: view.person.rev,
            })
            flash(`已删除 ${entry.label} 的一条观测`, {
              label: '撤销',
              run: async () => {
                try {
                  await applyWrite({
                    op: 'put-entry',
                    personId: view.person.personId,
                    entryKey: entry.key,
                    value: observation.value,
                    observedAt: observation.observedAt,
                  })
                  flash('已恢复')
                } catch {
                  // surfaced
                }
              },
            })
          } catch {
            // surfaced
          }
        },
        [applyWrite, flash, view],
      )

      const filtered = search.trim() === ''
        ? people
        : people.filter((person) => {
            const needle = search.trim().toLowerCase()
            const hay = [person.displayName, person.relation, ...(person.aliases ?? [])].filter(Boolean).join(' ').toLowerCase()
            return hay.includes(needle)
          })

      const top = h(
        'div',
        { className: 'pv-top' },
        h(
          'div',
          null,
          h('div', { className: 'pv-title' }, '个人资料'),
          h(
            'div',
            { className: 'pv-sub' },
            stats === null
              ? '正在读取…'
              : `${stats.people ?? people.length} 个人 · ${stats.entries ?? 0} 条条目${stats.encrypted === false ? ' · 未加密' : ''}`,
          ),
        ),
        h(
          'div',
          { className: 'pv-row' },
          h('button', { className: 'pv-btn pv-btn-ghost', onClick: () => setCreating((value) => !value) }, creating ? '收起新建' : '＋ 新建人物'),
          h(
            'button',
            {
              className: 'pv-btn pv-btn-ghost',
              onClick: async () => {
                const next = !showGrants
                setShowGrants(next)
                if (next) {
                  try {
                    const result = await requestJson(QUERY_PATH, { op: 'grants' })
                    setGrants(Array.isArray(result.grants) ? result.grants : [])
                  } catch (failure) {
                    setError(failure.message)
                  }
                }
              },
            },
            showGrants ? '收起授权' : 'AI 读取授权',
          ),
        ),
      )

      const noticeBar = h(
        'div',
        { className: 'pv-notice' },
        '资料以明文保存在本机（~/.dsh/dsh-profile-vault），没有加密。身份证、银行卡这类信息在这里默认显示掩码，AI 要完整值必须单独向你申请一次授权。',
      )

      const createRow = creating
        ? h(
            'div',
            { className: 'pv-form-row' },
            h(
              'label',
              { className: 'pv-field pv-grow' },
              h('span', null, '姓名'),
              h('input', { value: newName, placeholder: '要建档的人', onChange: (event) => setNewName(event.target.value) }),
            ),
            h(
              'button',
              {
                className: 'pv-btn pv-btn-primary',
                disabled: busy || newName.trim() === '',
                onClick: async () => {
                  try {
                    const result = await applyWrite({ op: 'create-person', displayName: newName.trim() })
                    const personId = result?.view?.person?.personId
                    setNewName('')
                    setCreating(false)
                    if (personId) await select(personId)
                    flash('已建档')
                  } catch {
                    // surfaced
                  }
                },
              },
              '建档',
            ),
          )
        : null

      const leftPane = h(
        'div',
        { className: 'pv-pane' },
        h(
          'div',
          { className: 'pv-pane-head' },
          h('span', null, '人物'),
          h('span', null, `${filtered.length}/${people.length}`),
        ),
        h('div', { style: { padding: '6px 8px 0' } },
          h('input', {
            style: { width: '100%' },
            value: search,
            placeholder: '按姓名/别名/关系搜',
            onChange: (event) => setSearch(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'pv-people' },
          filtered.length === 0
            ? h('div', { className: 'pv-empty' }, people.length === 0 ? '还没有人。\n先新建，或让 AI 用 profile_remember 记一条。' : '没有匹配的人。')
            : filtered.map((person) =>
                h(
                  'button',
                  {
                    key: person.personId,
                    className: 'pv-person' + (person.personId === selectedId ? ' on' : ''),
                    onClick: () => void select(person.personId),
                  },
                  h('span', { className: 'pv-person-name' }, person.displayName),
                  h(
                    'span',
                    { className: 'pv-person-meta' },
                    `${person.entriesCount} 条${person.relation ? ` · ${person.relation}` : ''} · ${formatDay(person.updatedAt)}`,
                  ),
                ),
              ),
        ),
      )

      const rightContent = view === null
        ? h('div', { className: 'pv-empty' }, '左边选一个人查看资料；也可以在右边新建一个人。\nAI 存进来的资料也会出现在这里。')
        : h(
            React.Fragment,
            null,
            h(PersonHeader, { person: view.person, busy, onSave: (patch) => void savePerson(patch) }),
            h(
              'div',
              { className: 'pv-row' },
              h('span', { className: 'pv-sub' }, `数据时间点 ${formatDay(view.asOf)}`),
              h('div', { className: 'pv-spacer' }),
              h(
                'button',
                {
                  className: 'pv-btn pv-btn-ghost',
                  disabled: busy,
                  onClick: async () => {
                    const next = !reveal
                    setReveal(next)
                    try {
                      await loadPerson(view.person.personId, { reveal: next, history: withHistory })
                    } catch (failure) {
                      setError(failure.message)
                    }
                  },
                },
                reveal ? '隐藏敏感值' : '显示敏感值',
              ),
              h(
                'button',
                {
                  className: 'pv-btn pv-btn-ghost',
                  disabled: busy,
                  onClick: async () => {
                    const next = !withHistory
                    setWithHistory(next)
                    setExpanded({})
                    try {
                      await loadPerson(view.person.personId, { reveal, history: next })
                    } catch (failure) {
                      setError(failure.message)
                    }
                  },
                },
                withHistory ? '收起历史' : '显示历史',
              ),
              h(
                'button',
                {
                  className: 'pv-btn pv-btn-ghost pv-btn-danger',
                  onClick: () =>
                    setModal({
                      kind: 'person',
                      personId: view.person.personId,
                      name: view.person.displayName,
                    }),
                },
                '删除这个人',
              ),
            ),
            draft === null
              ? h(
                  'button',
                  { className: 'pv-btn pv-btn-primary', onClick: () => setDraft(emptyDraft('')) },
                  '＋ 添加条目',
                )
              : h(EntryForm, {
                  draft,
                  catalog,
                  busy,
                  editing: draft.entryKey !== '',
                  onChange: setDraft,
                  onCancel: () => setDraft(null),
                  onSubmit: () => void submitDraft(),
                }),
            view.entries.length === 0
              ? h('div', { className: 'pv-empty' }, '这个人还没有任何条目。')
              : h(
                  'div',
                  { className: 'pv-entries' },
                  view.entries.map((entry) =>
                    h(EntryCard, {
                      key: entry.key,
                      entry,
                      expanded: expanded[entry.key] === true,
                      onEdit: (target) =>
                        setDraft({
                          entryKey: target.key,
                          value: target.current === null || target.current.masked === true ? '' : valueText(target),
                          observedAt: todayInput(),
                          last4: false,
                          identity: target.tier === 'sensitive',
                        }),
                      onDelete: (target) => setModal({ kind: 'entry', personId: view.person.personId, entry: target }),
                      onDeleteObservation: (target, observation) => void removeObservation(target, observation),
                      onToggleHistory: (key) => setExpanded((current) => ({ ...current, [key]: current[key] !== true })),
                    }),
                  ),
                ),
          )

      const grantsPane = showGrants
        ? h(
            'div',
            { className: 'pv-pane' },
            h(
              'div',
              { className: 'pv-pane-head' },
              h('span', null, 'AI 读取授权（本机全部会话）'),
              h('span', null, `${grants === null ? '…' : grants.length} 条有效`),
            ),
            h(
              'div',
              { className: 'pv-grants' },
              grants === null
                ? h('div', { className: 'pv-muted' }, '读取中…')
                : grants.length === 0
                  ? h('div', { className: 'pv-empty' }, '没有任何会话持有读取授权。')
                  : grants.map((grant) =>
                      h(
                        'div',
                        { key: grant.id, className: 'pv-grant' },
                        h(
                          'span',
                          null,
                          `${grant.subject?.label ?? grant.subject?.key ?? '资料'} · ${grant.tier === 'sensitive' ? '含敏感值' : '普通'} · 到期 ${formatStamp(grant.expiresAt)} · 已用 ${grant.useCount ?? 0} 次`,
                        ),
                        h(
                          'button',
                          {
                            className: 'pv-btn pv-btn-ghost pv-btn-danger',
                            disabled: busy,
                            onClick: async () => {
                              try {
                                await applyWrite({ op: 'revoke-grant', grantId: grant.id })
                                const result = await requestJson(QUERY_PATH, { op: 'grants' })
                                setGrants(Array.isArray(result.grants) ? result.grants : [])
                                flash('已撤销这条授权')
                              } catch {
                                // surfaced
                              }
                            },
                          },
                          '撤销',
                        ),
                      ),
                    ),
            ),
          )
        : null

      const modalNode = modal === null
        ? null
        : modal.kind === 'entry'
          ? h(ConfirmModal, {
              title: `删除「${modal.entry.label}」？`,
              description: `这个条目下的 ${modal.entry.observations} 条观测会一起移入 trash/（保留 30 天）。`,
              busy,
              onCancel: () => setModal(null),
              onConfirm: async () => {
                try {
                  await applyWrite({
                    op: 'delete-entry',
                    personId: modal.personId,
                    entryKey: modal.entry.key,
                    baseRev: view?.person?.rev,
                  })
                  setModal(null)
                  flash(`已删除条目：${modal.entry.label}`)
                } catch {
                  // surfaced
                }
              },
            })
          : h(ConfirmModal, {
              title: `删除「${modal.name}」的整个档案？`,
              description: '这个人的全部条目与观测都会移入 trash/（保留 30 天），之后 AI 也查不到。',
              requireText: modal.name,
              confirmLabel: '删除档案',
              busy,
              onCancel: () => setModal(null),
              onConfirm: async () => {
                try {
                  await applyWrite({ op: 'delete-person', personId: modal.personId, confirmName: modal.name })
                  setModal(null)
                  setView(null)
                  setSelectedId(null)
                  flash(`已删除档案：${modal.name}`)
                } catch {
                  // surfaced
                }
              },
            })

      return h(
        'div',
        { className: 'pv-root' },
        top,
        noticeBar,
        error === '' ? null : h('div', { className: 'pv-error' }, error),
        createRow,
        h(
          'div',
          { className: 'pv-grid' },
          h(
            'div',
            null,
            leftPane,
          ),
          h(
            'div',
            { className: 'pv-pane' },
            h('div', { className: 'pv-body' }, rightContent),
          ),
        ),
        grantsPane,
        notice === null
          ? null
          : h(
              'div',
              { className: 'pv-toast' },
              h('span', null, notice.text),
              notice.undo === null
                ? null
                : h(
                    'button',
                    {
                      className: 'pv-btn pv-btn-ghost',
                      onClick: async () => {
                        const action = notice.undo
                        setNotice(null)
                        if (action) await action.run()
                      },
                    },
                    notice.undo.label,
                  ),
              h('button', { className: 'pv-btn pv-btn-ghost', onClick: () => setNotice(null) }, '知道了'),
            ),
        modalNode,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const styleEl = createOwnedStyle(CSS)
      ctx.effect(() => () => styleEl.remove(), 'dsh-profile-vault: styles')

      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'profile-vault', order: 26, label: '个人资料' }, Panel),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { requestJson, formatDay, formatStamp, valueText, computedText, todayInput, createOwnedStyle, STYLE_OWNER_ID }
    return module.exports
  },
})
