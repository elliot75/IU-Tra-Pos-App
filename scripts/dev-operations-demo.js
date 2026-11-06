// Isolated synthetic PostgreSQL demo. Never loads .env or uses DATABASE_URL.
import { operationsDatabase } from '../test-support/operations-db.js';
import { OperationsStore } from '../src/operations.js';
import { createServer } from '../src/server.js';
import { createAuthTransport } from '../src/auth-transport.js';
const fixture=await operationsDatabase();
await fixture.pool.query('UPDATE iutra_pos.pos_grants SET permissions=$1 WHERE staff_id=$2',[['pos','bank.confirm','members','wallet.topup','wallet.charge','refund.request','reports','print'],fixture.ids.staff]);
const server=createServer({pool:fixture.pool,enableOperations:true,operations:new OperationsStore(fixture.pool,{requestHashKey:'isolated_demo_hmac_secret_012345678901234567890'}),authTransport:createAuthTransport({mode:'local-development',trustedProxyIps:''})});
server.listen(3001,'127.0.0.1',()=>{
  console.log('Isolated demo http://127.0.0.1:3001 (synthetic data reset on stop)');
  console.log(`Demo login: cashier / ${fixture.password}; device: ${fixture.ids.device}; device key: ${fixture.key}`);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await fixture.close();process.exit(0);}));
