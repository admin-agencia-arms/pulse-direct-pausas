// Uso: npm run admin -- email@dominio.com [--remove]
import { sql } from './db.js';
import { normEmail } from './auth.js';

const email = normEmail(process.argv[2]);
const remove = process.argv.includes('--remove');
if (!email) {
  console.log('Uso: npm run admin -- email@dominio.com [--remove]');
  process.exit(1);
}
const t = Date.now();
if (remove) {
  const r = await sql`UPDATE users SET role = 'user', updated_at = ${t} WHERE email = ${email} RETURNING id`;
  console.log(r.length ? `${email} agora é usuário.` : 'Usuário não encontrado.');
} else {
  const [r] = await sql`INSERT INTO users (email, name, role, created_at, updated_at)
    VALUES (${email}, ${email.split('@')[0]}, 'admin', ${t}, ${t})
    ON CONFLICT (email) DO UPDATE SET role = 'admin', updated_at = ${t}
    RETURNING (xmax = 0) AS created`;
  console.log(r.created ? `Conta local de administrador criada para ${email}. Defina a senha no primeiro acesso.` : `${email} agora é administrador.`);
}
await sql.end();
