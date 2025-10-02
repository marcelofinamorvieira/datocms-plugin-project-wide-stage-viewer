import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { RenderPageCtx } from 'datocms-plugin-sdk';
import { Button, Canvas, Section, Spinner } from 'datocms-react-ui';
import { buildCmaClient } from '../utils/cma';
import type { StageMenuItem } from '../types';
import s from './StagePage.module.css';

type Props = {
  ctx: RenderPageCtx;
  menuItem: StageMenuItem | null;
};

type WorkflowItemType = {
  id: string;
  name: string;
  api_key: string;
  modular_block: boolean;
  workflowId: string | null;
  presentationTitleFieldId: string | null;
  presentationTitleFieldApiKey?: string | null;
  titleFieldId: string | null;
  titleFieldApiKey?: string | null;
};

type ResolvedWorkflowItemType = WorkflowItemType & {
  presentationTitleFieldApiKey: string | null;
  titleFieldApiKey: string | null;
};

type ItemRecord = {
  id: string;
  attributes: Record<string, unknown>;
  meta?: {
    stage?: string | null;
    updated_at?: string | null;
  };
};

type Row = {
  id: string;
  itemTypeId: string;
  modelName: string;
  title: string;
  updatedAt: string | null;
};

type ModelOption = {
  value: string;
  label: string;
};

type SortDirection = 'asc' | 'desc';

type SortKey = 'title' | 'id' | 'modelName' | 'updatedAt';

function extractDisplayValue(value: unknown, locales: string[]): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractDisplayValue(entry, locales);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    const recordValue = value as Record<string, unknown>;

    for (const locale of locales) {
      const normalizedCandidates = Array.from(
        new Set([locale, locale.split('-')[0]?.trim()].filter(Boolean)),
      ) as string[];

      for (const candidateLocale of normalizedCandidates) {
        if (candidateLocale in recordValue) {
          const localized = extractDisplayValue(recordValue[candidateLocale], locales);
          if (localized) {
            return localized;
          }
        }
      }
    }

    const priorityKeys = ['title', 'name', 'label', 'value', 'text'];
    for (const key of priorityKeys) {
      if (key in recordValue) {
        const extracted = extractDisplayValue(recordValue[key], locales);
        if (extracted) {
          return extracted;
        }
      }
    }

    for (const entry of Object.values(recordValue)) {
      const extracted = extractDisplayValue(entry, locales);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function resolveRecordTitle(
  record: ItemRecord,
  locales: string[],
  preferredPresentationFieldApiKey?: string | null,
  fallbackTitleFieldApiKey?: string | null,
): string {
  const baseAttributes =
    (record as Record<string, unknown>).attributes &&
    typeof (record as Record<string, unknown>).attributes === 'object'
      ? ((record as Record<string, unknown>).attributes as Record<string, unknown>)
      : null;

  const ignoredKeys = baseAttributes
    ? null
    : new Set(['id', 'type', 'meta', 'relationships', 'item_type']);

  const attributeMap =
    baseAttributes ??
    Object.fromEntries(
      Object.entries(record as Record<string, unknown>).filter(([key, value]) => {
        return !(ignoredKeys?.has(key)) && typeof value !== 'function';
      }),
    );

  const preferredKeys = ['title', 'name', 'heading', 'label'];

  if (preferredPresentationFieldApiKey) {
    const candidate = attributeMap[preferredPresentationFieldApiKey];
    const resolved = extractDisplayValue(candidate, locales);
    if (resolved) {
      return resolved;
    }
  }

  if (fallbackTitleFieldApiKey) {
    const candidate = attributeMap[fallbackTitleFieldApiKey];
    const resolved = extractDisplayValue(candidate, locales);
    if (resolved) {
      return resolved;
    }
  }

  for (const key of preferredKeys) {
    const candidate = attributeMap[key];
    const resolved = extractDisplayValue(candidate, locales);
    if (resolved) {
      return resolved;
    }
  }

  for (const value of Object.values(attributeMap)) {
    const resolved = extractDisplayValue(value, locales);
    if (resolved) {
      return resolved;
    }
  }

  return `Record ${record.id}`;
}

function parseUpdatedAt(record: ItemRecord): string | null {
  const metaTimestamp = record.meta?.updated_at;
  if (typeof metaTimestamp === 'string' && metaTimestamp.trim() !== '') {
    return metaTimestamp;
  }

  const attrTimestamp = (record.attributes as Record<string, unknown>)?.updated_at;
  if (typeof attrTimestamp === 'string' && attrTimestamp.trim() !== '') {
    return attrTimestamp;
  }

  return null;
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '—';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString();
}

export default function StagePage({ ctx, menuItem }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'updatedAt',
    direction: 'desc',
  });

  const localePriority = useMemo(() => {
    const locales = ctx.site.attributes.locales ?? [];
    if (locales.length <= 1) {
      return locales;
    }

    const defaultLocale = locales[0];
    return [defaultLocale, ...locales.filter((locale) => locale !== defaultLocale)];
  }, [ctx.site.attributes.locales]);

  useEffect(() => {
    let isMounted = true;

    async function load(): Promise<void> {
      if (!menuItem) {
        setError('This page is no longer configured. Please regenerate it from the plugin settings.');
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);
        setInfoMessage(null);

        const client = buildCmaClient(ctx);
        const rawItemTypes = await client.itemTypes.list();
        const itemTypeCollection = Array.isArray(rawItemTypes) ? rawItemTypes : [];

        const mappedItemTypes: WorkflowItemType[] = (itemTypeCollection as Array<Record<string, any>>).map(
          (itemType) => {
            const workflowRel =
              (itemType.workflow as { id?: string } | null | undefined) ??
              itemType.relationships?.workflow?.data ??
              null;

            const presentationField =
              (itemType.presentation_title_field as { id?: string } | null | undefined) ??
              itemType.relationships?.presentation_title_field?.data ??
              itemType.attributes?.presentation_title_field ??
              null;

            const titleField =
              (itemType.title_field as { id?: string } | null | undefined) ??
              itemType.relationships?.title_field?.data ??
              itemType.attributes?.title_field ??
              null;

            return {
              id: String(itemType.id),
              name: String(itemType.name ?? itemType.attributes?.name ?? itemType.id ?? ''),
              api_key: String(itemType.api_key ?? itemType.attributes?.api_key ?? itemType.id ?? ''),
              modular_block: Boolean(
                typeof itemType.modular_block === 'boolean'
                  ? itemType.modular_block
                  : itemType.attributes?.modular_block,
              ),
              workflowId: workflowRel?.id ?? null,
              presentationTitleFieldId: presentationField?.id ?? null,
              presentationTitleFieldApiKey:
                (presentationField as { api_key?: string } | null | undefined)?.api_key ??
                (presentationField as { attributes?: { api_key?: string } } | null | undefined)?.attributes
                  ?.api_key ??
                null,
              titleFieldId: titleField?.id ?? null,
              titleFieldApiKey:
                (titleField as { api_key?: string } | null | undefined)?.api_key ??
                (titleField as { attributes?: { api_key?: string } } | null | undefined)?.attributes?.api_key ??
                null,
            };
          },
        );

        const itemTypes = mappedItemTypes.filter(
          (itemType) => itemType.workflowId === menuItem.workflowId && !itemType.modular_block,
        );

        if (!isMounted) {
          return;
        }

        const options = itemTypes
          .map((itemType) => ({ value: itemType.id, label: itemType.name }))
          .sort((a, b) => a.label.localeCompare(b.label));

        setModelOptions(options);
        setSelectedModelId((previous) => {
          if (!previous) {
            return null;
          }

          return options.some((option) => option.value === previous) ? previous : null;
        });

        if (itemTypes.length === 0) {
          setRows([]);
          setInfoMessage('No models are linked to this workflow in this environment.');
          return;
        }

        const fieldApiKeyCache = new Map<string, string | null>();
        const resolvedItemTypes: ResolvedWorkflowItemType[] = [];

        for (const itemType of itemTypes) {
          if (!isMounted) {
            return;
          }

          let presentationTitleFieldApiKey: string | null = itemType.presentationTitleFieldApiKey ?? null;
          const presentationFieldId = itemType.presentationTitleFieldId;

          if (!presentationTitleFieldApiKey && presentationFieldId) {
            if (fieldApiKeyCache.has(presentationFieldId)) {
              presentationTitleFieldApiKey = fieldApiKeyCache.get(presentationFieldId) ?? null;
            } else {
              try {
                const field = await client.fields.find(presentationFieldId);
                const fieldRecord = field as
                  | { api_key?: string; attributes?: { api_key?: string } }
                  | undefined
                  | null;
                const apiKey = fieldRecord?.api_key ?? fieldRecord?.attributes?.api_key ?? null;
                fieldApiKeyCache.set(presentationFieldId, apiKey);
                presentationTitleFieldApiKey = apiKey;
              } catch (lookupError) {
                fieldApiKeyCache.set(presentationFieldId, null);
              }
            }
          }

          let titleFieldApiKey: string | null = itemType.titleFieldApiKey ?? null;
          const titleFieldId = itemType.titleFieldId;

          if (!titleFieldApiKey && titleFieldId) {
            if (fieldApiKeyCache.has(titleFieldId)) {
              titleFieldApiKey = fieldApiKeyCache.get(titleFieldId) ?? null;
            } else {
              try {
                const field = await client.fields.find(titleFieldId);
                const fieldRecord = field as
                  | { api_key?: string; attributes?: { api_key?: string } }
                  | undefined
                  | null;
                const apiKey = fieldRecord?.api_key ?? fieldRecord?.attributes?.api_key ?? null;
                fieldApiKeyCache.set(titleFieldId, apiKey);
                titleFieldApiKey = apiKey;
              } catch (lookupError) {
                fieldApiKeyCache.set(titleFieldId, null);
              }
            }
          }

          resolvedItemTypes.push({
            ...itemType,
            presentationTitleFieldApiKey,
            titleFieldApiKey,
          });
        }

        if (!isMounted) {
          return;
        }

        const collectedRows: Row[] = [];

        await Promise.all(
          resolvedItemTypes.map(async (itemType) => {
            const iterator = client.items.listPagedIterator({
              filter: { type: itemType.id },
              version: 'current',
              nested: true,
              locale: localePriority[0],
            });

            for await (const record of iterator) {
              if (!isMounted) {
                break;
              }

              const typedRecord = record as unknown as ItemRecord;

              if (typedRecord.meta?.stage !== menuItem.stageId) {
                continue;
              }

              const title = resolveRecordTitle(
                typedRecord,
                localePriority,
                itemType.presentationTitleFieldApiKey,
                itemType.titleFieldApiKey,
              );

              collectedRows.push({
                id: typedRecord.id,
                itemTypeId: itemType.id,
                modelName: itemType.name,
                title,
                updatedAt: parseUpdatedAt(typedRecord),
              });

            }
          }),
        );

        if (!isMounted) {
          return;
        }

        collectedRows.sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        });

        setRows(collectedRows);
        setInfoMessage(
          collectedRows.length === 0
            ? 'No records are currently in this stage.'
            : null,
        );
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load records.');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      isMounted = false;
    };
  }, [ctx, localePriority, menuItem, reloadIndex]);

  const handleNavigate = useCallback(
    (itemTypeId: string, itemId: string) => {
      void ctx.navigateTo(`/editor/item_types/${itemTypeId}/items/${itemId}/edit`);
    },
    [ctx],
  );

  const filteredRows = useMemo(() => {
    if (!selectedModelId) {
      return rows;
    }

    return rows.filter((row) => row.itemTypeId === selectedModelId);
  }, [rows, selectedModelId]);

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];

    const compareStrings = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

    sorted.sort((a, b) => {
      const orderMultiplier = sortState.direction === 'asc' ? 1 : -1;

      switch (sortState.key) {
        case 'title':
          return compareStrings(a.title, b.title) * orderMultiplier;
        case 'id':
          return compareStrings(a.id, b.id) * orderMultiplier;
        case 'modelName':
          return compareStrings(a.modelName, b.modelName) * orderMultiplier;
        case 'updatedAt': {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          if (aTime === bTime) {
            return compareStrings(a.title, b.title) * orderMultiplier;
          }
          return (aTime - bTime) * orderMultiplier;
        }
        default:
          return 0;
      }
    });

    return sorted;
  }, [filteredRows, sortState]);

  const emptyStateMessage =
    rows.length === 0 ? infoMessage ?? 'No records found.' : 'No records match the selected model.';

  const handleModelFilterChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value.trim();
    setSelectedModelId(nextValue === '' ? null : nextValue);
  }, []);

  const handleSort = useCallback((key: SortKey) => {
    setSortState((current) => {
      if (current.key === key) {
        const nextDirection: SortDirection = current.direction === 'asc' ? 'desc' : 'asc';
        return { key, direction: nextDirection };
      }

      const defaultDirection: SortDirection = key === 'updatedAt' ? 'desc' : 'asc';
      return { key, direction: defaultDirection };
    });
  }, []);

  if (!menuItem) {
    return (
      <Canvas ctx={ctx}>
        <div className={s.container}>
          <Section title="Stage view unavailable">
            <p className={s.error}>
              This page no longer matches a saved workflow stage menu item. Please remove it from the
              plugin configuration.
            </p>
          </Section>
        </div>
      </Canvas>
    );
  }

  return (
    <Canvas ctx={ctx}>
      <div className={s.container}>
        <div className={s.section}>
          <Section title={menuItem.label ?? `${menuItem.stageName} (${menuItem.workflowName})`}>
            <div className={s.headerRow}>
              <div className={s.headerMain}>
                <p className={s.summary}>
                  Showing records currently in the <strong>{menuItem.stageName}</strong> stage of the{' '}
                  <strong>{menuItem.workflowName}</strong> workflow.
                </p>
                {modelOptions.length > 0 ? (
                  <label className={s.filterControl}>
                    <span className={s.filterLabel}>Model</span>
                    <select
                      className={s.select}
                      value={selectedModelId ?? ''}
                      onChange={handleModelFilterChange}
                    >
                      <option value="">All models</option>
                      {modelOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <Button buttonType="muted" buttonSize="s" onClick={() => setReloadIndex((value) => value + 1)}>
                Refresh
              </Button>
            </div>
            {error ? <p className={s.error}>{error}</p> : null}
            {isLoading ? (
              <div className={s.loading}>
                <Spinner />
                <span>Loading records...</span>
              </div>
            ) : sortedRows.length > 0 ? (
              <div className={s.tableWrapper}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        aria-sort={sortState.key === 'title' ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button type="button" className={s.sortButton} onClick={() => handleSort('title')}>
                          <span>Title</span>
                          <span
                            className={`${s.sortIndicator} ${
                              sortState.key === 'title'
                                ? sortState.direction === 'asc'
                                  ? s.sortAsc
                                  : s.sortDesc
                                : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </th>
                      <th
                        scope="col"
                        aria-sort={sortState.key === 'id' ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button type="button" className={s.sortButton} onClick={() => handleSort('id')}>
                          <span>Record ID</span>
                          <span
                            className={`${s.sortIndicator} ${
                              sortState.key === 'id'
                                ? sortState.direction === 'asc'
                                  ? s.sortAsc
                                  : s.sortDesc
                                : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </th>
                      <th
                        scope="col"
                        aria-sort={
                          sortState.key === 'modelName'
                            ? sortState.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button type="button" className={s.sortButton} onClick={() => handleSort('modelName')}>
                          <span>Model</span>
                          <span
                            className={`${s.sortIndicator} ${
                              sortState.key === 'modelName'
                                ? sortState.direction === 'asc'
                                  ? s.sortAsc
                                  : s.sortDesc
                                : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </th>
                      <th
                        scope="col"
                        aria-sort={
                          sortState.key === 'updatedAt'
                            ? sortState.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button type="button" className={s.sortButton} onClick={() => handleSort('updatedAt')}>
                          <span>Updated</span>
                          <span
                            className={`${s.sortIndicator} ${
                              sortState.key === 'updatedAt'
                                ? sortState.direction === 'asc'
                                  ? s.sortAsc
                                  : s.sortDesc
                                : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </th>
                      <th scope="col">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.title}</td>
                        <td className={s.recordId}>{row.id}</td>
                        <td>{row.modelName}</td>
                        <td>{formatTimestamp(row.updatedAt)}</td>
                        <td>
                          <Button
                            buttonType="primary"
                            buttonSize="s"
                            onClick={() => handleNavigate(row.itemTypeId, row.id)}
                          >
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={s.empty}>{emptyStateMessage}</p>
            )}
          </Section>
        </div>
      </div>
    </Canvas>
  );
}
