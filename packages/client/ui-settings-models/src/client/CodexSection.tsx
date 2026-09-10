/** Credential-free Codex configuration and DPH-owned request queue. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexConfiguration, CodexController, CodexState } from './codex-store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import codexStyles from './CodexSection.module.css'

/** Plain callbacks and snapshot used by the registered Codex section. */
export interface CodexInjected {
  hooks: { codex: SnapshotStore<CodexState> }
  controller: CodexController
  t: (key: keyof typeof en) => string
}

type Props = PropsRuntime<'settings.section'> & InjectFace<CodexInjected>

/** Render the local CLI controls with the existing settings visual language.
 * @param props - framework-bound state and management callbacks.
 * @returns Codex settings and queue table.
 */
export function CodexSection(props: Props): ReactNode {
  const { controller, t, useCodex } = props
  const state = useCodex(value => value)
  const [draft, setDraft] = useState<CodexConfiguration | null>(null)
  useEffect(() => controller.watch(), [controller])
  const config = draft ?? state.config
  const update = (next: Partial<CodexConfiguration>): void => { if (config) setDraft({ ...config, ...next }) }
  return <section className={styles.section}>
    <h2 className={styles.title}>{t('codexTitle')}</h2>
    <p className={styles.intro}>{t('codexIntro')}</p>
    <p>{state.status?.version ?? t('codexUnknown')} · {t(`codexAuth_${state.status?.authentication ?? 'unknown'}`)}</p>
    {(state.error ?? state.status?.error) && <p role="alert" className={styles.notice}>{state.error ?? state.status?.error}</p>}
    {state.result && <p role="status" className={styles.savedNotice}>{state.result}</p>}
    {config && <div className={`${styles.rowCard} ${codexStyles.form}`}>
      <label><input type="checkbox" checked={config.enabled} disabled={state.busy} onChange={event => update({ enabled: event.target.checked })} />{t('codexEnabled')}</label>
      <label>{t('codexCommand')}<input value={config.command} disabled={state.busy} onChange={event => update({ command: event.target.value })} /></label>
      <label>{t('codexModel')}<input value={config.model} disabled={state.busy} onChange={event => update({ model: event.target.value })} /></label>
      <label>{t('codexProxy')}<input value={config.proxyUrl} disabled={state.busy} onChange={event => update({ proxyUrl: event.target.value })} /></label>
      <label>{t('codexTimeout')}<input type="number" min={1} max={86400} value={config.timeoutSeconds} disabled={state.busy} onChange={event => update({ timeoutSeconds: Number(event.target.value) })} /></label>
      <Button disabled={state.busy} onClick={() => { void controller.act('save', config).then(saved => { if (saved) setDraft(null) }) }}>{t('apply')}</Button>
    </div>}
    <div className={styles.rowHead}>
      <Button disabled={state.busy} onClick={() => { void controller.act('detect') }}>{t('codexDetect')}</Button>
      <Button disabled={state.busy || !state.status?.enabled || state.status.paused} onClick={() => { void controller.act('test') }}>{t('codexTest')}</Button>
      <Button disabled={state.busy || !state.status?.enabled} onClick={() => { void controller.act('default') }}>{t('codexDefault')}</Button>
      <Button disabled={state.busy || !state.status?.enabled} onClick={() => { void controller.act('pause', !state.status?.paused) }}>{state.status?.paused ? t('codexResume') : t('codexPause')}</Button>
    </div>
    <p className={styles.intro}>{t('codexLoginHint')}</p>
    <h3>{t('codexQueue')}</h3>
    <p className={styles.intro}>{t('codexQueueHint')}</p>
    <ul className={styles.rows}>{state.status?.tasks.slice().reverse().map(task => <li key={task.id} className={styles.rowCard}>
      <div>{task.model} · {t(`codexTask_${task.status}`)}</div>
      <small>{task.id} · {task.createdAt}</small>
      {task.sessionId && <small>{task.sessionId}</small>}
      {task.error && <p role="alert">{task.error}</p>}
      {['queued', 'starting', 'running'].includes(task.status) && <Button onClick={() => { void controller.act('cancel', task.id) }}>{t('cancel')}</Button>}
    </li>)}</ul>
  </section>
}
