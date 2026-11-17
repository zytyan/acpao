package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type journalEvent struct {
	Seq       int64  `json:"seq"`
	Session   string `json:"session"`
	Kind      string `json:"kind"`
	Data      any    `json:"data"`
	CreatedAt int64  `json:"createdAt"`
}

type store struct {
	db *sql.DB
	mu sync.Mutex
}

func openStore(path string) (*store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
	CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
	CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT);
	CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	_, _ = db.Exec(`UPDATE receipts SET status='done',error='{"code":"INTERRUPTED","message":"Gateway restarted while executing this command; it was not replayed"}' WHERE status='executing'`)
	_ = os.Chmod(path, 0600)
	return &store{db: db}, nil
}

func (s *store) put(kind, id string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO objects(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, kind, id, string(data))
	return err
}
func (s *store) get(kind, id string, out any) error {
	var data string
	if err := s.db.QueryRow(`SELECT data FROM objects WHERE kind=? AND id=?`, kind, id).Scan(&data); err != nil {
		return err
	}
	return json.Unmarshal([]byte(data), out)
}
func (s *store) all(kind string) ([]json.RawMessage, error) {
	rows, err := s.db.Query(`SELECT data FROM objects WHERE kind=?`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []json.RawMessage
	for rows.Next() {
		var data string
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		result = append(result, json.RawMessage(data))
	}
	return result, rows.Err()
}
func (s *store) event(session, kind string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO journal(session,kind,data,createdAt) VALUES(?,?,?,?)`, session, kind, string(data), time.Now().UnixMilli())
	return err
}
func (s *store) events(after int64, limit int) ([]journalEvent, error) {
	rows, err := s.db.Query(`SELECT seq,session,kind,data,createdAt FROM journal WHERE seq>? ORDER BY seq LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []journalEvent
	for rows.Next() {
		var e journalEvent
		var data []byte
		if err = rows.Scan(&e.Seq, &e.Session, &e.Kind, &data, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Data = json.RawMessage(data)
		out = append(out, e)
	}
	return out, rows.Err()
}
func (s *store) floor() int64 {
	var v int64
	_ = s.db.QueryRow(`SELECT COALESCE(MIN(seq),0) FROM journal`).Scan(&v)
	return v
}
func (s *store) ack(cursor int64) error {
	_, err := s.db.Exec(`DELETE FROM journal WHERE seq<=?`, cursor)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings(key,value) VALUES('floor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, fmt.Sprint(cursor))
	return err
}
func (s *store) savedFloor() int64 {
	var v int64
	_ = s.db.QueryRow(`SELECT COALESCE((SELECT value FROM settings WHERE key='floor'),'0')`).Scan(&v)
	return v
}

type receipt struct {
	ID          string          `json:"id"`
	Fingerprint string          `json:"fingerprint"`
	Status      string          `json:"status"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       *wireError      `json:"error,omitempty"`
}
type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func fingerprint(action string, payload json.RawMessage) string {
	sum := sha256.Sum256(append([]byte(action+":"), payload...))
	return hex.EncodeToString(sum[:])
}
func (s *store) receipt(id string) (*receipt, error) {
	var r receipt
	var result, errorData sql.NullString
	err := s.db.QueryRow(`SELECT id,fingerprint,status,result,error FROM receipts WHERE id=?`, id).Scan(&r.ID, &r.Fingerprint, &r.Status, &result, &errorData)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if result.Valid {
		r.Result = json.RawMessage(result.String)
	}
	if errorData.Valid {
		r.Error = new(wireError)
		if err = json.Unmarshal([]byte(errorData.String), r.Error); err != nil {
			return nil, err
		}
	}
	return &r, nil
}
func (s *store) saveReceipt(r receipt) error {
	var failure any
	if r.Error != nil {
		b, _ := json.Marshal(r.Error)
		failure = string(b)
	}
	_, err := s.db.Exec(`INSERT INTO receipts(id,fingerprint,status,result,error) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,result=excluded.result,error=excluded.error`, r.ID, r.Fingerprint, r.Status, string(r.Result), failure)
	return err
}
