import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QldbDriver, Result, TransactionExecutor, RetryConfig } from "amazon-qldb-driver-nodejs";
import { dom } from "ion-js";
import { ArrayIn, ArrayLike, LedgerDBInterface } from './ledger.db.interface';
import { Agent } from 'https';
import { QLDBSessionClientConfig } from "@aws-sdk/client-qldb-session";
import { NodeHttpHandlerOptions } from "@aws-sdk/node-http-handler";

@Injectable()
export class QLDBLedgerService implements LedgerDBInterface {

    public tableName: string;
    public overallTableName: string;
    public companyTableName: string;
    public ledgerName: string;
    private driver: QldbDriver;

    constructor(private readonly logger: Logger, private readonly configService: ConfigService) {
        this.ledgerName = configService.get<string>('ledger.name');
        this.tableName = configService.get<string>('ledger.table');
        this.overallTableName = configService.get<string>('ledger.overallTable');
        this.companyTableName = configService.get<string>('ledger.companyTable');
        this.driver = this.createQldbDriver(this.ledgerName);
        logger.log("[QLDBLedgerService] constructor initialized. ", this.ledgerName);
    }

    private createQldbDriver(ledgerName: string): QldbDriver {
        const maxConcurrentTransactions: number = 5;
        const retryLimit: number = 2;

        //Reuse connections with keepAlive
        const lowLevelClientHttpOptions: NodeHttpHandlerOptions = {
            httpAgent: new Agent({
                maxSockets: maxConcurrentTransactions
            })
        };

        const serviceConfigurationOptions: QLDBSessionClientConfig = {
            region: "us-east-1"
        };

        //Use driver's default backoff function for this example (no second parameter provided to RetryConfig)
        const retryConfig: RetryConfig = new RetryConfig(retryLimit);

        const driver = new QldbDriver(ledgerName,
            serviceConfigurationOptions,
            lowLevelClientHttpOptions,
            maxConcurrentTransactions,
            retryConfig);

        this.logger.debug('[createQldbDriver] Created.');

        return driver;
    }

    // TODO: Handler session expire
    private async execute<TM>(sql, ...parameters: any[]): Promise<Result> {
        let result: Result;

        // try {
        //this.driver = this.createQldbDriver(this.ledgerName);
        result = await this.driver.executeLambda(async (txn: TransactionExecutor) =>
            this.executeTxn(txn, sql, ...parameters));
        this.logger.debug('[execute] Response', JSON.stringify(result));
        // } catch (error) {
        //     this.logger.error('[execute]', error);
        // }
        // finally {
        //     this.driver.close();
        // }

        return result;
    }

    private async executeTxn<TM>(txn: TransactionExecutor, sql, ...parameters: any[]): Promise<Result> {
        this.logger.debug(`[QLDBLedger executeTxn] Statement: ${sql}, parameter: ${JSON.stringify(parameters)}`);

        if (parameters.length > 0) {
            return await txn.execute(sql, ...parameters);
        } else {
            return await txn.execute(sql);
        }
    }

    public async createTable(tableName?: string): Promise<void> {
        await this.execute(`CREATE TABLE ${tableName ? tableName : this.tableName}`);
    }

    public async createIndex(indexCol: string, tableName?: string): Promise<void> {
        await this.execute(`CREATE INDEX ON ${tableName ? tableName : this.tableName} (${indexCol})`);
    }

    public async insertRecord(document: Record<string, any>, tableName?: string): Promise<void> {
        await this.execute(`INSERT INTO ${tableName ? tableName : this.tableName} ?`, document);
    }

    public async fetchRecords(where: Record<string, any>): Promise<dom.Value[]> {
        const whereClause = Object.keys(where).map(k => (`${k} = ?`)).join(' and ');
        return (await this.execute(`SELECT * FROM ${this.tableName} WHERE ${whereClause}`, ...Object.values(where)))?.getResultList();
    }

    public async fetchHistory(where: Record<string, any>): Promise<dom.Value[]> {
        const whereClause = Object.keys(where).map(k => (`h.data.${k} = ?`)).join(' and ');
        const x = (await this.execute(`SELECT * FROM history(${this.tableName}) as h WHERE ${whereClause}`, ...Object.values(where)))?.getResultList();
        console.log('Results', x);
        return x;
    }

    public async updateRecords(update: Record<string, any>, where: Record<string, any>): Promise<dom.Value[]> {
        const whereClause = Object.keys(where).map(k => (`${k} = ?`)).join(' and ');
        const updateClause = Object.keys(update).map(k => (`${k} = ?`)).join(',');
        return (await this.execute(`UPDATE ${this.tableName} SET ${updateClause} WHERE ${whereClause}`, ...Object.values(update), ...Object.values(where)))?.getResultList();
    };

    private getValuesList(filterObj: any): any {
        const list = [];
        for (const k in filterObj) {
            const v = filterObj[k];
            if (v instanceof ArrayIn) {
                list.push(v.value);
            } else if (v instanceof ArrayLike) {
                list.push(v.value);
            } else {
                list.push(v);
            }
        }
        return list;
    }

    public async getAndUpdateTx<TM>(getQueries: Record<string, Record<string, any>>, processGetFn: (results: Record<string, dom.Value[]>) => [Record<string, any>, Record<string, any>, Record<string, any>]): Promise<Record<string, dom.Value[]>> {
        this.logger.debug(``);
        //this.driver = this.createQldbDriver(this.ledgerName);
        const resp = await this.driver.executeLambda(async (txn: TransactionExecutor) => {
            const getResults = {};
            for (const t in getQueries) {
                if (getQueries.hasOwnProperty(t)) {
                    const wc = Object.keys(getQueries[t]).map(k => {
                        if (getQueries[t][k] instanceof Array) {
                            return (`${k} in ?`);
                        } else if (getQueries[t][k] instanceof ArrayIn) {
                            return (`? IN "${getQueries[t][k].key}"`);
                        } else if (getQueries[t][k] instanceof ArrayLike) {
                            return (`${k} LIKE ?`);
                        }
                        return (`${k} = ?`);
                    }).join(' and ');
                    const r = (await this.executeTxn(txn, `SELECT * FROM ${t} WHERE ${wc}`, ...this.getValuesList(getQueries[t])))?.getResultList();
                    getResults[t] = r;
                }
            }
            const [update, updateWhere, insert] = processGetFn(getResults);
            const updateResults = {};
            for (const qk in update) {
                const tableName = qk.split('#')[0];
                if (update.hasOwnProperty(qk) && updateWhere.hasOwnProperty(qk)) {
                    const whereClause = Object.keys(updateWhere[qk]).map(k => (`${k} = ?`)).join(' and ');
                    const updateClause = Object.keys(update[qk]).map(k => (`${k} = ?`)).join(',');
                    updateResults[qk] = (await this.executeTxn(txn, `UPDATE ${tableName} SET ${updateClause} WHERE ${whereClause}`, ...Object.values(update[qk]), ...Object.values(updateWhere[qk])))?.getResultList();
                }
            }

            this.logger.verbose(`Insert queries`, JSON.stringify(insert));
            for (const qk in insert) {
                const tableName = qk.split('#')[0];
                if (insert.hasOwnProperty(qk)) {
                    updateResults[qk] = (await this.executeTxn(txn, `INSERT INTO ${tableName ? tableName : this.tableName} ?`, insert[qk]))?.getResultList();
                }
            }

            return updateResults;
        });
        this.logger.debug('Response', JSON.stringify(resp));
        //this.driver.close();
        return resp;
    }

}
