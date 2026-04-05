import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Input, Spin, Empty, Dropdown, message, Tooltip, Modal } from 'antd';
import { TableOutlined, SearchOutlined, ReloadOutlined, SortAscendingOutlined, DatabaseOutlined, ConsoleSqlOutlined, EditOutlined, CopyOutlined, SaveOutlined, DeleteOutlined, ExportOutlined, AppstoreOutlined, UnorderedListOutlined, WarningOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { DBQuery, DBShowCreateTable, ExportTable, DropTable, RenameTable } from '../../wailsjs/go/app/App';
import type { TabData } from '../types';
import { useAutoFetchVisibility } from '../utils/autoFetchVisibility';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';

interface TableOverviewProps {
    tab: TabData;
}

interface TableStatRow {
    name: string;
    comment: string;
    rows: number;
    dataSize: number;
    indexSize: number;
    engine: string;
    createTime: string;
    updateTime: string;
}

type SortField = 'name' | 'rows' | 'dataSize';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'card' | 'list';

const formatSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatRows = (count: number): string => {
    if (count === undefined || count === null || count < 0) return '—';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
};

const getMetadataDialect = (connType: string, driver?: string): string => {
    const type = (connType || '').trim().toLowerCase();
    if (type === 'custom') {
        const d = (driver || '').trim().toLowerCase();
        if (d === 'diros' || d === 'doris') return 'mysql';
        return d;
    }
    if (type === 'mariadb' || type === 'diros' || type === 'sphinx') return 'mysql';
    if (type === 'dameng') return 'dm';
    return type;
};

const buildTableStatusSQL = (dialect: string, dbName: string, schemaName?: string): string => {
    const escapeLiteral = (s: string) => s.replace(/'/g, "''");
    switch (dialect) {
        case 'mysql':
            return `SHOW TABLE STATUS FROM \`${dbName.replace(/`/g, '``')}\``;
        case 'postgres':
        case 'kingbase':
        case 'vastbase':
        case 'highgo': {
            const schema = schemaName || 'public';
            return `
SELECT
    n.nspname || '.' || c.relname AS table_name,
    obj_description(c.oid, 'pg_class') AS table_comment,
    c.reltuples::bigint AS table_rows,
    pg_total_relation_size(c.oid) AS data_length,
    pg_indexes_size(c.oid) AS index_length
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = '${escapeLiteral(schema)}'
ORDER BY c.relname`;
        }
        case 'sqlserver': {
            const safeDB = `[${dbName.replace(/]/g, ']]')}]`;
            return `
SELECT
    s.name + '.' + t.name AS table_name,
    ep.value AS table_comment,
    SUM(p.rows) AS table_rows,
    SUM(a.total_pages) * 8 * 1024 AS data_length,
    SUM(a.used_pages) * 8 * 1024 AS index_length
FROM ${safeDB}.sys.tables t
JOIN ${safeDB}.sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN ${safeDB}.sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
LEFT JOIN ${safeDB}.sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
LEFT JOIN ${safeDB}.sys.allocation_units a ON p.partition_id = a.container_id
WHERE t.type = 'U'
GROUP BY s.name, t.name, ep.value
ORDER BY s.name, t.name`;
        }
        case 'clickhouse':
            return `SELECT name AS table_name, comment AS table_comment, total_rows AS table_rows, total_bytes AS data_length, 0 AS index_length FROM system.tables WHERE database = '${escapeLiteral(dbName)}' AND engine NOT IN ('View', 'MaterializedView') ORDER BY name`;
        case 'dm':
        case 'oracle': {
            const owner = (schemaName || dbName).toUpperCase();
            return `SELECT table_name, comments AS table_comment, num_rows AS table_rows, 0 AS data_length, 0 AS index_length FROM all_tab_comments JOIN all_tables USING (table_name, owner) WHERE owner = '${escapeLiteral(owner)}' ORDER BY table_name`;
        }
        default:
            return `SELECT table_name, '' AS table_comment, 0 AS table_rows, 0 AS data_length, 0 AS index_length FROM information_schema.tables WHERE table_schema = '${escapeLiteral(dbName)}' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    }
};

const parseTableStats = (dialect: string, rows: Record<string, any>[]): TableStatRow[] => {
    return rows.map((row) => {
        const get = (keys: string[]): any => {
            for (const k of keys) {
                for (const rk of Object.keys(row)) {
                    if (rk.toLowerCase() === k.toLowerCase() && row[rk] !== null && row[rk] !== undefined) return row[rk];
                }
            }
            return undefined;
        };
        const strVal = (keys: string[]) => String(get(keys) ?? '').trim();
        const numVal = (keys: string[]) => {
            const v = get(keys);
            if (v === null || v === undefined || v === '') return 0;
            const n = Number(v);
            return isNaN(n) ? 0 : Math.max(0, Math.round(n));
        };

        return {
            name: strVal(['Name', 'table_name', 'tablename', 'TABLE_NAME']),
            comment: strVal(['Comment', 'table_comment', 'TABLE_COMMENT', 'comments']),
            rows: numVal(['Rows', 'table_rows', 'TABLE_ROWS', 'num_rows', 'reltuples', 'total_rows']),
            dataSize: numVal(['Data_length', 'data_length', 'DATA_LENGTH', 'total_bytes']),
            indexSize: numVal(['Index_length', 'index_length', 'INDEX_LENGTH']),
            engine: strVal(['Engine', 'engine']),
            createTime: strVal(['Create_time', 'create_time']),
            updateTime: strVal(['Update_time', 'update_time']),
        };
    }).filter(t => t.name);
};

const TableOverview: React.FC<TableOverviewProps> = ({ tab }) => {
    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const darkMode = theme === 'dark';

    const [tables, setTables] = useState<TableStatRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchText, setSearchText] = useState('');
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
    const [viewMode, setViewMode] = useState<ViewMode>('card');

    const connection = useMemo(() => connections.find(c => c.id === tab.connectionId), [connections, tab.connectionId]);
    const autoFetchVisible = useAutoFetchVisibility();

    const loadData = useCallback(async () => {
        if (!connection) return;
        setLoading(true);
        try {
            const config = {
                ...connection.config,
                port: Number(connection.config.port),
                password: connection.config.password || '',
                database: connection.config.database || '',
                useSSH: connection.config.useSSH || false,
                ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            };
            const dialect = getMetadataDialect(connection.config.type, connection.config.driver);
            const sql = buildTableStatusSQL(dialect, tab.dbName || '', (tab as any).schemaName);
            const res = await DBQuery(buildRpcConnectionConfig(config) as any, tab.dbName || '', sql);
            if (res.success && Array.isArray(res.data)) {
                setTables(parseTableStats(dialect, res.data));
            } else {
                message.error('获取表信息失败: ' + (res.message || '未知错误'));
            }
        } catch (e: any) {
            message.error('获取表信息失败: ' + (e?.message || String(e)));
        } finally {
            setLoading(false);
        }
    }, [connection, tab.dbName]);

    useEffect(() => {
        if (!autoFetchVisible) {
            return;
        }
        void loadData();
    }, [autoFetchVisible, loadData]);

    const sortedFiltered = useMemo(() => {
        let list = [...tables];
        if (searchText.trim()) {
            const kw = searchText.trim().toLowerCase();
            list = list.filter(t => t.name.toLowerCase().includes(kw) || t.comment.toLowerCase().includes(kw));
        }
        list.sort((a, b) => {
            let cmp = 0;
            if (sortField === 'name') cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            else if (sortField === 'rows') cmp = a.rows - b.rows;
            else if (sortField === 'dataSize') cmp = a.dataSize - b.dataSize;
            return sortOrder === 'asc' ? cmp : -cmp;
        });
        return list;
    }, [tables, searchText, sortField, sortOrder]);

    const openTable = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        addTab({
            id: `${connection.id}-${tab.dbName}-${tableName}`,
            title: tableName,
            type: 'table',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
        });
    }, [connection, tab.dbName, addTab, setActiveContext]);

    const openDesign = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        addTab({
            id: `design-${connection.id}-${tab.dbName}-${tableName}`,
            title: `设计表 (${tableName})`,
            type: 'design',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
            initialTab: 'columns',
            readOnly: false,
        });
    }, [connection, tab.dbName, addTab, setActiveContext]);

    const buildConfig = useCallback(() => {
        if (!connection) return null;
        return {
            ...connection.config,
            port: Number(connection.config.port),
            password: connection.config.password || '',
            database: connection.config.database || '',
            useSSH: connection.config.useSSH || false,
            ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        };
    }, [connection]);

    const handleCopyStructure = useCallback(async (tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
        if (res.success) {
            navigator.clipboard.writeText(res.data as string);
            message.success('表结构已复制到剪贴板');
        } else {
            message.error(res.message);
        }
    }, [buildConfig, tab.dbName]);

    const handleExport = useCallback(async (tableName: string, format: string) => {
        const config = buildConfig();
        if (!config) return;
        const hide = message.loading(`正在导出 ${tableName} 为 ${format.toUpperCase()}...`, 0);
        const res = await ExportTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName, format);
        hide();
        if (res.success) {
            message.success('导出成功');
        } else if (res.message !== '已取消') {
            message.error('导出失败: ' + res.message);
        }
    }, [buildConfig, tab.dbName]);

    const handleDeleteTable = useCallback((tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        Modal.confirm({
            title: '确认删除表',
            content: `确定删除表 "${tableName}" 吗？该操作不可恢复。`,
            okButtonProps: { danger: true },
            onOk: async () => {
                const res = await DropTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
                if (res.success) {
                    message.success('表删除成功');
                    loadData();
                } else {
                    message.error('删除失败: ' + res.message);
                }
            },
        });
    }, [buildConfig, tab.dbName, loadData]);

    const handleRenameTable = useCallback((tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        let newName = tableName;
        Modal.confirm({
            title: '重命名表',
            content: (
                <Input
                    defaultValue={tableName}
                    onChange={e => { newName = e.target.value; }}
                    placeholder="输入新表名"
                    autoFocus
                    style={{ marginTop: 8 }}
                />
            ),
            onOk: async () => {
                const trimmed = newName.trim();
                if (!trimmed) { message.error('表名不能为空'); return Promise.reject(); }
                if (trimmed === tableName) { message.warning('新旧表名相同'); return; }
                const res = await RenameTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName, trimmed);
                if (res.success) {
                    message.success('表重命名成功');
                    loadData();
                } else {
                    message.error('重命名失败: ' + res.message);
                }
            },
        });
    }, [buildConfig, tab.dbName, loadData]);

    // --- Theme ---
    const cardBg = darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
    const cardHoverBg = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
    const cardBorder = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const textPrimary = darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.88)';
    const textSecondary = darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    const textMuted = darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    const accentColor = '#1677ff';
    const containerBg = darkMode ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.01)';

    const toggleSort = (field: SortField) => {
        if (sortField === field) {
            setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortOrder(field === 'name' ? 'asc' : 'desc');
        }
    };

    const sortMenuItems = [
        { key: 'name', label: `按名称${sortField === 'name' ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}`, onClick: () => toggleSort('name') },
        { key: 'rows', label: `按行数${sortField === 'rows' ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}`, onClick: () => toggleSort('rows') },
        { key: 'dataSize', label: `按大小${sortField === 'dataSize' ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}`, onClick: () => toggleSort('dataSize') },
    ];

    const totalRows = tables.reduce((s, t) => s + t.rows, 0);
    const totalSize = tables.reduce((s, t) => s + t.dataSize + t.indexSize, 0);

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: containerBg }}>
                <Spin size="large" tip="加载表信息..." />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: containerBg, overflow: 'hidden' }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', flexShrink: 0 }}>
                <DatabaseOutlined style={{ fontSize: 16, color: accentColor }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: textPrimary }}>{tab.dbName}</span>
                <span style={{ fontSize: 12, color: textMuted }}>
                    {tables.length} 张表 · {formatRows(totalRows)} 行 · {formatSize(totalSize)}
                </span>
                <div style={{ flex: 1 }} />
                <Input
                    placeholder="搜索表名或注释..."
                    prefix={<SearchOutlined style={{ color: textMuted }} />}
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    allowClear
                    style={{ width: 240 }}
                    size="small"
                />
                <Dropdown menu={{ items: sortMenuItems }} trigger={['click']}>
                    <Tooltip title="排序"><SortAscendingOutlined style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
                </Dropdown>
                <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 6, background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                    <Tooltip title="卡片视图">
                        <div
                            onClick={() => setViewMode('card')}
                            style={{
                                padding: '3px 7px', borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
                                background: viewMode === 'card' ? (darkMode ? 'rgba(255,255,255,0.12)' : '#fff') : 'transparent',
                                boxShadow: viewMode === 'card' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                                color: viewMode === 'card' ? accentColor : textMuted,
                            }}
                        >
                            <AppstoreOutlined style={{ fontSize: 14 }} />
                        </div>
                    </Tooltip>
                    <Tooltip title="列表视图">
                        <div
                            onClick={() => setViewMode('list')}
                            style={{
                                padding: '3px 7px', borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
                                background: viewMode === 'list' ? (darkMode ? 'rgba(255,255,255,0.12)' : '#fff') : 'transparent',
                                boxShadow: viewMode === 'list' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                                color: viewMode === 'list' ? accentColor : textMuted,
                            }}
                        >
                            <UnorderedListOutlined style={{ fontSize: 14 }} />
                        </div>
                    </Tooltip>
                </div>
                <Tooltip title="刷新"><ReloadOutlined onClick={loadData} style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
            </div>

            {/* Content Area */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px 16px' }}>
                {sortedFiltered.length === 0 ? (
                    <Empty description={searchText ? '无匹配结果' : '暂无表'} style={{ marginTop: 80 }} />
                ) : viewMode === 'card' ? (
                    /* ========== 卡片视图 ========== */
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: 12,
                    }}>
                        {sortedFiltered.map(t => (
                            <Dropdown
                                key={t.name}
                                trigger={['contextMenu']}
                                menu={{
                                    items: [
                                        { key: 'new-query', label: '新建查询', icon: <ConsoleSqlOutlined />, onClick: () => {
                                            setActiveContext({ connectionId: tab.connectionId, dbName: tab.dbName || '' });
                                            addTab({
                                                id: `query-${Date.now()}`,
                                                title: '新建查询',
                                                type: 'query',
                                                connectionId: tab.connectionId,
                                                dbName: tab.dbName,
                                                query: `SELECT * FROM ${t.name};`,
                                            });
                                        }},
                                        { type: 'divider' },
                                        { key: 'design-table', label: '设计表', icon: <EditOutlined />, onClick: () => openDesign(t.name) },
                                        { key: 'copy-structure', label: '复制表结构', icon: <CopyOutlined />, onClick: () => handleCopyStructure(t.name) },
                                        { key: 'backup-table', label: '备份表 (SQL)', icon: <SaveOutlined />, onClick: () => handleExport(t.name, 'sql') },
                                        { key: 'rename-table', label: '重命名表', icon: <EditOutlined />, onClick: () => handleRenameTable(t.name) },
                                        { key: 'danger-zone', label: '危险操作', icon: <WarningOutlined />, children: [
                                            { key: 'drop-table', label: '删除表', icon: <DeleteOutlined />, danger: true, onClick: () => handleDeleteTable(t.name) }
                                        ]},
                                        { type: 'divider' },
                                        { key: 'export', label: '导出表数据', icon: <ExportOutlined />, children: [
                                            { key: 'export-csv', label: '导出 CSV', onClick: () => handleExport(t.name, 'csv') },
                                            { key: 'export-xlsx', label: '导出 Excel (XLSX)', onClick: () => handleExport(t.name, 'xlsx') },
                                            { key: 'export-json', label: '导出 JSON', onClick: () => handleExport(t.name, 'json') },
                                            { key: 'export-md', label: '导出 Markdown', onClick: () => handleExport(t.name, 'md') },
                                            { key: 'export-html', label: '导出 HTML', onClick: () => handleExport(t.name, 'html') },
                                        ]},
                                    ],
                                }}
                            >
                                <div
                                    onDoubleClick={() => openTable(t.name)}
                                    style={{
                                        background: cardBg,
                                        border: `1px solid ${cardBorder}`,
                                        borderRadius: 10,
                                        padding: '14px 16px',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s ease',
                                        userSelect: 'none',
                                    }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = cardHoverBg; (e.currentTarget as HTMLDivElement).style.borderColor = accentColor; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = cardBg; (e.currentTarget as HTMLDivElement).style.borderColor = cardBorder; }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                        <TableOutlined style={{ fontSize: 14, color: accentColor }} />
                                        <Tooltip title={t.name} mouseEnterDelay={0.4}>
                                            <span style={{ fontSize: 13, fontWeight: 600, color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, display: 'block' }}>
                                                {t.name}
                                            </span>
                                        </Tooltip>
                                    </div>
                                    {t.comment && (
                                        <Tooltip title={t.comment} mouseEnterDelay={0.4}>
                                            <div style={{ fontSize: 12, color: textSecondary, marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {t.comment}
                                            </div>
                                        </Tooltip>
                                    )}
                                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: textMuted }}>
                                        <span title="行数" style={{ minWidth: 52 }}>📊 {formatRows(t.rows)}</span>
                                        <span title="数据大小" style={{ minWidth: 72 }}>💾 {formatSize(t.dataSize)}</span>
                                        {t.engine && <span title="引擎" style={{ marginLeft: 'auto', opacity: 0.7 }}>{t.engine}</span>}
                                    </div>
                                </div>
                            </Dropdown>
                        ))}
                    </div>
                ) : (
                    /* ========== 列表/表格视图 ========== */
                    <div style={{ borderRadius: 8, border: `1px solid ${cardBorder}`, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                                <tr style={{ background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' }}>
                                    {[
                                        { field: 'name' as SortField, label: '表名', width: undefined },
                                        { field: null, label: '注释', width: undefined },
                                        { field: 'rows' as SortField, label: '行数', width: 100 },
                                        { field: 'dataSize' as SortField, label: '数据大小', width: 110 },
                                        { field: null, label: '索引大小', width: 110 },
                                        { field: null, label: '引擎', width: 90 },
                                    ].map((col, idx) => (
                                        <th
                                            key={idx}
                                            onClick={col.field ? () => toggleSort(col.field!) : undefined}
                                            style={{
                                                padding: '10px 14px',
                                                textAlign: idx >= 2 ? 'right' : 'left',
                                                fontWeight: 600,
                                                color: textSecondary,
                                                borderBottom: `1px solid ${cardBorder}`,
                                                cursor: col.field ? 'pointer' : 'default',
                                                userSelect: 'none',
                                                whiteSpace: 'nowrap',
                                                width: col.width,
                                            }}
                                        >
                                            {col.label}
                                            {col.field && sortField === col.field && (
                                                <span style={{ marginLeft: 4, fontSize: 11 }}>
                                                    {sortOrder === 'asc' ? '↑' : '↓'}
                                                </span>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {sortedFiltered.map((t, rowIdx) => (
                                    <Dropdown
                                        key={t.name}
                                        trigger={['contextMenu']}
                                        menu={{
                                            items: [
                                                { key: 'new-query', label: '新建查询', icon: <ConsoleSqlOutlined />, onClick: () => {
                                                    setActiveContext({ connectionId: tab.connectionId, dbName: tab.dbName || '' });
                                                    addTab({
                                                        id: `query-${Date.now()}`,
                                                        title: '新建查询',
                                                        type: 'query',
                                                        connectionId: tab.connectionId,
                                                        dbName: tab.dbName,
                                                        query: `SELECT * FROM ${t.name};`,
                                                    });
                                                }},
                                                { type: 'divider' },
                                                { key: 'design-table', label: '设计表', icon: <EditOutlined />, onClick: () => openDesign(t.name) },
                                                { key: 'copy-structure', label: '复制表结构', icon: <CopyOutlined />, onClick: () => handleCopyStructure(t.name) },
                                                { key: 'backup-table', label: '备份表 (SQL)', icon: <SaveOutlined />, onClick: () => handleExport(t.name, 'sql') },
                                                { key: 'rename-table', label: '重命名表', icon: <EditOutlined />, onClick: () => handleRenameTable(t.name) },
                                                { key: 'danger-zone', label: '危险操作', icon: <WarningOutlined />, children: [
                                                    { key: 'drop-table', label: '删除表', icon: <DeleteOutlined />, danger: true, onClick: () => handleDeleteTable(t.name) }
                                                ]},
                                                { type: 'divider' },
                                                { key: 'export', label: '导出表数据', icon: <ExportOutlined />, children: [
                                                    { key: 'export-csv', label: '导出 CSV', onClick: () => handleExport(t.name, 'csv') },
                                                    { key: 'export-xlsx', label: '导出 Excel (XLSX)', onClick: () => handleExport(t.name, 'xlsx') },
                                                    { key: 'export-json', label: '导出 JSON', onClick: () => handleExport(t.name, 'json') },
                                                    { key: 'export-md', label: '导出 Markdown', onClick: () => handleExport(t.name, 'md') },
                                                    { key: 'export-html', label: '导出 HTML', onClick: () => handleExport(t.name, 'html') },
                                                ]},
                                            ],
                                        }}
                                    >
                                        <tr
                                            onDoubleClick={() => openTable(t.name)}
                                            style={{
                                                cursor: 'pointer',
                                                transition: 'background 0.12s',
                                                borderBottom: rowIdx < sortedFiltered.length - 1 ? `1px solid ${cardBorder}` : 'none',
                                            }}
                                            onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = cardHoverBg; }}
                                            onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
                                        >
                                            <td style={{ padding: '10px 14px', color: textPrimary, fontWeight: 500 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <TableOutlined style={{ fontSize: 13, color: accentColor, flexShrink: 0 }} />
                                                    <Tooltip title={t.name} mouseEnterDelay={0.4}>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                                                    </Tooltip>
                                                </div>
                                            </td>
                                            <td style={{ padding: '10px 14px', color: textSecondary, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {t.comment ? (
                                                    <Tooltip title={t.comment} mouseEnterDelay={0.4}><span>{t.comment}</span></Tooltip>
                                                ) : (
                                                    <span style={{ color: textMuted }}>—</span>
                                                )}
                                            </td>
                                            <td style={{ padding: '10px 14px', textAlign: 'right', color: textSecondary, fontVariantNumeric: 'tabular-nums' }}>{formatRows(t.rows)}</td>
                                            <td style={{ padding: '10px 14px', textAlign: 'right', color: textSecondary, fontVariantNumeric: 'tabular-nums' }}>{formatSize(t.dataSize)}</td>
                                            <td style={{ padding: '10px 14px', textAlign: 'right', color: textSecondary, fontVariantNumeric: 'tabular-nums' }}>{formatSize(t.indexSize)}</td>
                                            <td style={{ padding: '10px 14px', textAlign: 'right', color: textMuted }}>{t.engine || '—'}</td>
                                        </tr>
                                    </Dropdown>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TableOverview;
