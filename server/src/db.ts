import { Pool, type QueryResultRow } from 'pg'

export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>

export interface Db {
  pool: Pool
  query: QueryFn
  withTx: <T>(fn: (q: QueryFn) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

export function createDb(url: string, max = 10): Db {
  const pool = new Pool({ connectionString: url, max })

  const query: QueryFn = async (sql, params) => pool.query(sql, params)

  const withTx = async <T>(fn: (q: QueryFn) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    const q: QueryFn = (sql, params) => client.query(sql, params)
    try {
      await client.query('BEGIN')
      const out = await fn(q)
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  return { pool, query, withTx, close: () => pool.end() }
}
