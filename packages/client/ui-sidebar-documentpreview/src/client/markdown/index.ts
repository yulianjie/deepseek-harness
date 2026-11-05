/** Builtin Markdown metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { HostMarkdownBody, MarkdownBody } from './MarkdownBody.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

/** Implementation identity shared by metadata and the document slot. */
export const MARKDOWN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'

/**
 * Describe the Markdown implementation without taking ownership of loading.
 * @param title - locale-owned implementation name.
 * @returns builtin Markdown registration metadata.
 */
export function markdownDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: MARKDOWN_BODY_ID, extensions: ['md', 'markdown'], priority: 'builtin', title, loading: 'text-pages', wrap: false }
}

/**
 * Register locale, metadata, and the document body for the owning plugin lifetime.
 * @param ctx - plugin context carrying locale, document registry, and slots.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('documentMarkdown')
  ctx.effect(() => ctx.locale.register('documentMarkdown', { zh, en, ja, es, fr, de, ru, pt }), 'document-markdown: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(markdownDefinition(() => t('viewer.label'))), 'document-markdown: metadata')
  const resourceUrl = ctx.get('hostPageAccess')?.resourceUrl
  const hostMediaGeneration = ctx.get('connection')?.generation
    ?? { getSnapshot: () => undefined, subscribe: () => () => {} }
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => {
    const entry = { name: 'sidebar.right.tab.document', key: MARKDOWN_BODY_ID, locale: 'documentMarkdown' } as const
    if (resourceUrl === undefined) return ctx.slots.register(entry, MarkdownBody)
    return ctx.slots.register({
      ...entry, inject: () => ({ resourceUrl, hooks: { hostMediaGeneration } }),
    }, HostMarkdownBody)
  }), 'document-markdown: body')
}
