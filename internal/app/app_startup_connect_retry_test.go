package app

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

type fakeStartupRetryDB struct {
	connect func(config connection.ConnectionConfig) error
}

func (f *fakeStartupRetryDB) Connect(config connection.ConnectionConfig) error {
	if f.connect != nil {
		return f.connect(config)
	}
	return nil
}

func (f *fakeStartupRetryDB) Close() error { return nil }
func (f *fakeStartupRetryDB) Ping() error  { return nil }
func (f *fakeStartupRetryDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (f *fakeStartupRetryDB) Exec(query string) (int64, error)          { return 0, nil }
func (f *fakeStartupRetryDB) GetDatabases() ([]string, error)           { return nil, nil }
func (f *fakeStartupRetryDB) GetTables(dbName string) ([]string, error) { return nil, nil }
func (f *fakeStartupRetryDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *fakeStartupRetryDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *fakeStartupRetryDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeStartupRetryDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeStartupRetryDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeStartupRetryDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func TestConnectDatabaseWithStartupRetry_RetriesTransientFailureAndReappliesGlobalProxy(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	snapshot := currentGlobalProxyConfig()
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(snapshot.Enabled, snapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
	}()

	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}

	seenConfigs := make([]connection.ConnectionConfig, 0, 2)
	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				seenConfigs = append(seenConfigs, config)
				if connectCalls == 1 {
					_, _ = setGlobalProxyConfig(true, connection.ProxyConfig{Type: "socks5", Host: "127.0.0.1", Port: 1080})
					return errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")
				}
				return nil
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now()}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, effectiveConfig, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err != nil {
		t.Fatalf("connectDatabaseWithStartupRetry returned error: %v", err)
	}
	if connectCalls != 2 {
		t.Fatalf("expected 2 connect attempts, got %d", connectCalls)
	}
	if len(seenConfigs) != 2 {
		t.Fatalf("expected 2 seen configs, got %d", len(seenConfigs))
	}
	if seenConfigs[0].UseProxy {
		t.Fatalf("expected first attempt without proxy, got %+v", seenConfigs[0])
	}
	if !seenConfigs[1].UseProxy {
		t.Fatalf("expected second attempt with proxy after startup retry, got %+v", seenConfigs[1])
	}
	if !effectiveConfig.UseProxy {
		t.Fatalf("expected returned effective config to include proxy, got %+v", effectiveConfig)
	}
}

func TestConnectDatabaseWithStartupRetry_RetriesOnceOutsideStartupWindow(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				return errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now().Add(-startupConnectRetryWindow - time.Second)}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, _, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connectCalls != 2 {
		t.Fatalf("expected 2 connect attempts outside startup window, got %d", connectCalls)
	}
}

func TestConnectDatabaseWithStartupRetry_DoesNotRetryOutsideStartupWindowForNonTransientError(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				return errors.New("pq: password authentication failed")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now().Add(-startupConnectRetryWindow - time.Second)}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, _, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connectCalls != 1 {
		t.Fatalf("expected 1 connect attempt outside startup window for non-transient error, got %d", connectCalls)
	}
}

func TestConnectDatabaseWithStartupRetry_LogsRetryHintOutsideStartupWindow(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	logPath := logger.Path()
	beforeSize := int64(0)
	if fi, err := os.Stat(logPath); err == nil {
		beforeSize = fi.Size()
	}

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				if connectCalls == 1 {
					return errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")
				}
				return nil
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now().Add(-startupConnectRetryWindow - time.Second)}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, _, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err != nil {
		t.Fatalf("expected success after retry, got error: %v", err)
	}
	if connectCalls != 2 {
		t.Fatalf("expected 2 connect attempts, got %d", connectCalls)
	}

	logContent, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatalf("read log failed: %v", readErr)
	}
	if int64(len(logContent)) < beforeSize {
		t.Fatalf("expected log file to grow, before=%d after=%d", beforeSize, len(logContent))
	}
	appended := string(logContent[beforeSize:])
	if !strings.Contains(appended, "检测到瞬时网络失败，准备重试连接") {
		t.Fatalf("expected retry hint log in appended segment, got: %s", appended)
	}
}

func TestConnectDatabaseWithStartupRetry_OutsideStartupWindowTransientFailureStopsAfterOneRetry(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				return errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now().Add(-startupConnectRetryWindow - time.Second)}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, _, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connectCalls != 2 {
		t.Fatalf("expected 2 connect attempts outside startup window for transient error, got %d", connectCalls)
	}
}

func TestConnectDatabaseWithStartupRetry_StartupWindowTransientFailureUsesFullRetryBudget(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				return errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{startedAt: time.Now()}
	rawConfig := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, _, err := a.connectDatabaseWithStartupRetry(rawConfig)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if connectCalls != startupConnectRetryAttempts {
		t.Fatalf("expected %d connect attempts in startup window, got %d", startupConnectRetryAttempts, connectCalls)
	}
}

func TestIsTransientStartupConnectError(t *testing.T) {
	if !isTransientStartupConnectError(errors.New("dial tcp 10.1.131.86:5432: connect: no route to host")) {
		t.Fatal("expected no route to host to be treated as transient startup connect error")
	}
	if isTransientStartupConnectError(errors.New("pq: password authentication failed")) {
		t.Fatal("expected authentication failure to not be treated as transient startup connect error")
	}
}

func TestGetDatabaseWithPing_CoolsDownRepeatedFailures(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				return errors.New("dial tcp 10.1.131.86:5432: connect: connection refused")
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{
		startedAt:      time.Now().Add(-startupConnectRetryWindow - time.Second),
		dbCache:        make(map[string]cachedDatabase),
		connectFailures: make(map[string]cachedConnectFailure),
		runningQueries: make(map[string]queryContext),
	}
	config := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, firstErr := a.getDatabaseWithPing(config, false)
	if firstErr == nil {
		t.Fatal("expected first connection attempt to fail")
	}
	if connectCalls != 2 {
		t.Fatalf("expected first request to use 2 connect attempts, got %d", connectCalls)
	}

	_, secondErr := a.getDatabaseWithPing(config, false)
	if secondErr == nil {
		t.Fatal("expected second connection attempt to fail during cooldown")
	}
	if connectCalls != 2 {
		t.Fatalf("expected repeated request during cooldown to avoid reconnecting, got %d connect attempts", connectCalls)
	}
}

func TestGetDatabaseWithPing_AllowsRetryAfterFailureCooldown(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				if connectCalls <= 2 {
					return errors.New("dial tcp 10.1.131.86:5432: connect: connection refused")
				}
				return nil
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{
		startedAt:      time.Now().Add(-startupConnectRetryWindow - time.Second),
		dbCache:        make(map[string]cachedDatabase),
		connectFailures: make(map[string]cachedConnectFailure),
		runningQueries: make(map[string]queryContext),
	}
	config := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, firstErr := a.getDatabaseWithPing(config, false)
	if firstErr == nil {
		t.Fatal("expected first connection attempt to fail")
	}
	if connectCalls != 2 {
		t.Fatalf("expected first request to use 2 connect attempts, got %d", connectCalls)
	}

	key := getCacheKey(config)
	a.mu.Lock()
	a.connectFailures[key] = cachedConnectFailure{
		occurredAt: time.Now().Add(-dbConnectFailureCooldown - time.Second),
		err:        errors.New("dial tcp 10.1.131.86:5432: connect: connection refused"),
	}
	a.mu.Unlock()

	inst, secondErr := a.getDatabaseWithPing(config, false)
	if secondErr != nil {
		t.Fatalf("expected retry after cooldown to be allowed, got error: %v", secondErr)
	}
	if inst == nil {
		t.Fatal("expected database instance after cooldown retry")
	}
	if connectCalls != 3 {
		t.Fatalf("expected reconnect after cooldown expiration, got %d connect attempts", connectCalls)
	}
}

func TestGetDatabaseWithPing_ClearsFailureCooldownAfterSuccess(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	}()

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeStartupRetryDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				if connectCalls <= 2 {
					return errors.New("dial tcp 10.1.131.86:5432: connect: connection refused")
				}
				return nil
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	a := &App{
		startedAt:      time.Now().Add(-startupConnectRetryWindow - time.Second),
		dbCache:        make(map[string]cachedDatabase),
		connectFailures: make(map[string]cachedConnectFailure),
		runningQueries: make(map[string]queryContext),
	}
	config := connection.ConnectionConfig{Type: "postgres", Host: "10.1.131.86", Port: 5432, User: "postgres"}

	_, firstErr := a.getDatabaseWithPing(config, false)
	if firstErr == nil {
		t.Fatal("expected first connection attempt to fail")
	}

	key := getCacheKey(config)
	a.mu.Lock()
	a.connectFailures[key] = cachedConnectFailure{
		occurredAt: time.Now().Add(-dbConnectFailureCooldown - time.Second),
		err:        errors.New("dial tcp 10.1.131.86:5432: connect: connection refused"),
	}
	a.mu.Unlock()

	_, secondErr := a.getDatabaseWithPing(config, false)
	if secondErr != nil {
		t.Fatalf("expected retry after cooldown to succeed, got error: %v", secondErr)
	}

	a.mu.RLock()
	_, exists := a.connectFailures[key]
	a.mu.RUnlock()
	if exists {
		t.Fatal("expected successful connection to clear cached failure cooldown")
	}
}
