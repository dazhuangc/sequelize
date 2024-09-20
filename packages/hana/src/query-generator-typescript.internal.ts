import type {
  DropSchemaQueryOptions,
  DropTableQueryOptions,
  Expression,
  StartTransactionQueryOptions,
  TableOrModel,
} from '@sequelize/core';
import type {
  ListSchemasQueryOptions,
  ListTablesQueryOptions,
  RemoveIndexQueryOptions,
  ShowConstraintsQueryOptions,
} from '@sequelize/core';
import type { AddLimitOffsetOptions } from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator.internal-types.js';
import type {
  EscapeOptions,
} from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator-typescript.js';
import { AbstractQueryGenerator, Op } from '@sequelize/core';
import { rejectInvalidOptions } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/check.js';
import { joinSQLFragments } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/join-sql-fragments.js';
import { EMPTY_SET } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/object.js';
import { buildJsonPath } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/json.js';
import { generateIndexName } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/string.js';
import {
  DROP_SCHEMA_QUERY_SUPPORTABLE_OPTIONS,
  REMOVE_INDEX_QUERY_SUPPORTABLE_OPTIONS,
} from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator-typescript.js';
import type { HanaDialect } from './dialect.js';
import { HanaQueryGeneratorInternal } from './query-generator.internal.js';
import { DROP_TABLE_QUERY_SUPPORTABLE_OPTIONS } from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator-typescript.js';

const DROP_SCHEMA_QUERY_SUPPORTED_OPTIONS = new Set<keyof DropSchemaQueryOptions>([
  'cascade',
]);

const REMOVE_INDEX_QUERY_SUPPORTED_OPTIONS = new Set<keyof RemoveIndexQueryOptions>();

/**
 * Temporary class to ease the TypeScript migration
 */
export class HanaQueryGeneratorTypeScript extends AbstractQueryGenerator {
  readonly #internals: HanaQueryGeneratorInternal;

  constructor(
    dialect: HanaDialect,
    internals: HanaQueryGeneratorInternal = new HanaQueryGeneratorInternal(dialect),
  ) {
    super(dialect, internals);

    this.#internals = internals;
  }

  listSchemasQuery(options?: ListSchemasQueryOptions) {
    let schemasToSkip = this.#internals.getTechnicalSchemaNames();

    if (options && Array.isArray(options?.skip)) {
      schemasToSkip = [...schemasToSkip, ...options.skip];
    }

    return joinSQLFragments([
      'SELECT SCHEMA_NAME AS "schema"',
      'FROM SYS.SCHEMAS',
      `WHERE SCHEMA_NAME != 'SYS' AND SCHEMA_NAME != 'PUBLIC' AND SCHEMA_NAME NOT LIKE '_SYS%'`,
      `AND SCHEMA_NAME NOT IN (${schemasToSkip.map(schema => this.escape(schema)).join(', ')})`,
    ]);
  }

  describeTableQuery(tableName: TableOrModel) {
    const table = this.extractTableDetails(tableName);

    return joinSQLFragments([
      'SELECT',
      'SYS.TABLE_COLUMNS.COLUMN_NAME AS "ColumnName",',
      'SYS.TABLE_COLUMNS.TABLE_NAME AS "TableName",',
      'SYS.TABLE_COLUMNS.SCHEMA_NAME AS "SchemaName",',
      'SYS.TABLE_COLUMNS.DATA_TYPE_NAME AS "DataTypeName",',
      'SYS.TABLE_COLUMNS.LENGTH AS "Length",',
      'SYS.TABLE_COLUMNS.SCALE AS "Scale",',
      'SYS.TABLE_COLUMNS.IS_NULLABLE AS "IsNullable",',
      'SYS.TABLE_COLUMNS.DEFAULT_VALUE AS "DefaultValue",',
      'SYS.TABLE_COLUMNS.GENERATION_TYPE AS "GenerationType",',
      'pk.IS_PRIMARY_KEY AS "IsPrimaryKey",',
      'SYS.TABLE_COLUMNS.COMMENTS AS "Comments"',
      'FROM SYS.TABLE_COLUMNS',
      'LEFT JOIN',
      '(SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME, IS_PRIMARY_KEY',
      `FROM SYS.CONSTRAINTS WHERE IS_PRIMARY_KEY = 'TRUE') pk`,
      'ON SYS.TABLE_COLUMNS.SCHEMA_NAME = pk.SCHEMA_NAME',
      'AND SYS.TABLE_COLUMNS.TABLE_NAME = pk.TABLE_NAME',
      'AND SYS.TABLE_COLUMNS.COLUMN_NAME = pk.COLUMN_NAME',
      `WHERE SYS.TABLE_COLUMNS.TABLE_NAME = ${this.escape(table.tableName)}`,
      `AND SYS.TABLE_COLUMNS.SCHEMA_NAME = ${table.schema ? this.escape(table.schema) : 'CURRENT_SCHEMA'}`,
    ]);
  }

  listTablesQuery(options?: ListTablesQueryOptions) {
    //"SELECT * FROM SYS.TABLES WHERE SCHEMA_NAME != 'SYS' and SCHEMA_NAME NOT LIKE '_SYS%'"
    return joinSQLFragments([
      'SELECT TABLE_NAME AS "tableName",',
      'SCHEMA_NAME AS "schema"',
      'FROM SYS.TABLES',
      `WHERE SCHEMA_NAME != 'SYS' AND SCHEMA_NAME NOT LIKE '_SYS%'`,
      options?.schema
        ? `AND SCHEMA_NAME = ${this.escape(options.schema)}`
        : `AND SCHEMA_NAME NOT IN (${this.#internals.getTechnicalSchemaNames().map(schema => this.escape(schema)).join(', ')})`,
      'ORDER BY SCHEMA_NAME, TABLE_NAME',
    ]);
  }

  dropTableQuery(tableName: TableOrModel, options?: DropTableQueryOptions): string {
    const DROP_TABLE_QUERY_SUPPORTED_OPTIONS = new Set<keyof DropTableQueryOptions>();

    if (this.dialect.supports.dropTable.cascade) {
      DROP_TABLE_QUERY_SUPPORTED_OPTIONS.add('cascade');
    }

    if (options) {
      rejectInvalidOptions(
        'dropTableQuery',
        this.dialect,
        DROP_TABLE_QUERY_SUPPORTABLE_OPTIONS,
        DROP_TABLE_QUERY_SUPPORTED_OPTIONS,
        options,
      );
    }

    const dropSql = joinSQLFragments([
      'DROP TABLE',
      this.quoteTable(tableName),
      options?.cascade ? 'CASCADE' : '',
    ]);

    const table = this.extractTableDetails(tableName);

    return joinSQLFragments([
      'DO BEGIN',
      'DECLARE table_count INTEGER;',
      `SELECT COUNT(*) INTO table_count FROM TABLES`,
      `WHERE TABLE_NAME = ${this.escape(table.tableName)} AND SCHEMA_NAME = ${table.schema ? this.escape(table.schema) : 'CURRENT_SCHEMA'};`,
      'IF :table_count > 0 THEN',
      `  EXEC '` + dropSql + `';`,
      'END IF;',
      'END;',
    ]);
  }

  showConstraintsQuery(tableName: TableOrModel, options?: ShowConstraintsQueryOptions) {
    const table = this.extractTableDetails(tableName);

    if (options?.constraintType === 'FOREIGN KEY') {
      // return 'SELECT * FROM "SYS"."REFERENTIAL_CONSTRAINTS"';
      return joinSQLFragments([
        'SELECT SCHEMA_NAME AS "constraintSchema",',
        'CONSTRAINT_NAME AS "constraintName",',
        `'FOREIGN KEY' AS "constraintType",`,
        'SCHEMA_NAME AS "tableSchema",',
        'TABLE_NAME AS "tableName",',
        'COLUMN_NAME AS "columnNames",',
        'REFERENCED_SCHEMA_NAME AS "referencedTableSchema",',
        'REFERENCED_TABLE_NAME AS "referencedTableName",',
        'REFERENCED_COLUMN_NAME AS "referencedColumnNames",',
        'DELETE_RULE AS "deleteAction",',
        'UPDATE_RULE AS "updateAction"',
        'FROM SYS.REFERENTIAL_CONSTRAINTS',
        `WHERE TABLE_NAME = ${this.escape(table.tableName)}`,
        `AND SCHEMA_NAME = ${table.schema ? this.escape(table.schema) : 'CURRENT_SCHEMA'}`,
        options?.columnName ? `AND COLUMN_NAME = ${this.escape(options.columnName)}` : '',
        options?.constraintName ? `AND CONSTRAINT_NAME = ${this.escape(options.constraintName)}` : '',
        'ORDER BY CONSTRAINT_NAME, POSITION',
      ]);
    }
    return 'unsupported method showConstraintsQuery, type not FOREIGN KEY';
  }

  showIndexesQuery(tableName: TableOrModel) {
    const table = this.extractTableDetails(tableName);

    return joinSQLFragments([
      'SELECT',
      'SYS.INDEXES.SCHEMA_NAME AS "schemaName",',
      'SYS.INDEXES.TABLE_NAME AS "tableName",',
      'SYS.INDEXES.INDEX_NAME AS "name",',
      'SYS.INDEXES.INDEX_TYPE AS "type",',
      'SYS.INDEXES.CONSTRAINT AS "constraint",',
      'SYS.INDEX_COLUMNS.COLUMN_NAME AS "columnName",',
      'SYS.INDEX_COLUMNS.POSITION AS "position",',
      'SYS.INDEX_COLUMNS.ASCENDING_ORDER AS "ascendingOrder"',

      'FROM SYS.INDEXES',
      'INNER JOIN SYS.INDEX_COLUMNS',
      'ON SYS.INDEXES.SCHEMA_NAME = SYS.INDEX_COLUMNS.SCHEMA_NAME',
      'AND SYS.INDEXES.TABLE_NAME = SYS.INDEX_COLUMNS.TABLE_NAME',
      'AND SYS.INDEXES.INDEX_NAME = SYS.INDEX_COLUMNS.INDEX_NAME',
      `WHERE SYS.INDEXES.SCHEMA_NAME = ${table.schema ? this.escape(table.schema) : 'CURRENT_SCHEMA'}`,
      `AND SYS.INDEXES.TABLE_NAME = ${this.escape(table.tableName)}`,
    ]);

    // `SELECT * FROM SYS.INDEXES WHERE SCHEMA_NAME ='${}' and TABLE_NAME = '' ${this.quoteTable(tableName)}`;
  }

  getToggleForeignKeyChecksQuery(enable: boolean): string {
    return `SET FOREIGN_KEY_CHECKS=${enable ? '1' : '0'}`;
  }

  removeIndexQuery(
    tableName: TableOrModel,
    indexNameOrAttributes: string | string[],
    options?: RemoveIndexQueryOptions,
  ) {
    if (options) {
      rejectInvalidOptions(
        'removeIndexQuery',
        this.dialect,
        REMOVE_INDEX_QUERY_SUPPORTABLE_OPTIONS,
        REMOVE_INDEX_QUERY_SUPPORTED_OPTIONS,
        options,
      );
    }

    let indexName: string;
    if (Array.isArray(indexNameOrAttributes)) {
      const table = this.extractTableDetails(tableName);
      indexName = generateIndexName(table, { fields: indexNameOrAttributes });
    } else {
      indexName = indexNameOrAttributes;
    }

    return `DROP INDEX ${this.quoteIdentifier(indexName)}`;
  }

  jsonPathExtractionQuery(sqlExpression: string, path: ReadonlyArray<number | string>, unquote: boolean): string {
    const extractQuery = `json_extract(${sqlExpression},${this.escape(buildJsonPath(path))})`;
    if (unquote) {
      return `json_unquote(${extractQuery})`;
    }

    return extractQuery;
  }

  formatUnquoteJson(arg: Expression, options?: EscapeOptions) {
    return `json_unquote(${this.escape(arg, options)})`;
  }

  versionQuery() {
    return `SELECT "VALUE" AS "version" FROM SYS.M_SYSTEM_OVERVIEW `
      + `WHERE "SECTION" = 'System' and "NAME" = 'Version';`;
  }

  tableExistsQuery(tableName: TableOrModel): string {
    const table = this.extractTableDetails(tableName);

    return `SELECT TABLE_NAME FROM "SYS"."TABLES" WHERE SCHEMA_NAME = ${table.schema ? this.escape(table.schema) : 'CURRENT_SCHEMA'} AND TABLE_NAME = ${this.escape(table.tableName)}`;
  }

  startTransactionQuery(options?: StartTransactionQueryOptions) {
    console.log('generator.ts hana startTransactionQuery', options)
    const transactionId = 'test_transaction';
    return `SAVEPOINT ${this.quoteIdentifier(transactionId, true)};`;
  }

  // /**
  //  * Returns a query that commits a transaction.
  //  *
  //  * @param  {Transaction} transaction An object with options.
  //  * @returns {string}         The generated sql query.
  //  * @private
  //  */
  // commitTransactionQuery(transaction) {
  //   if (transaction.parent) {
  //     return;
  //   }

  //   return 'COMMIT;';
  // }

  /**
   * Returns a query that rollbacks a transaction.
   *
   * @param  {Transaction} transaction
   * @returns {string}         The generated sql query.
   * @private
   */
  rollbackTransactionQuery() {
    console.log('generator.ts hana ···')
    const transactionId = 'test_transaction';
    return `ROLLBACK TO SAVEPOINT ${this.quoteIdentifier(transactionId, true)};`;
  }
}
