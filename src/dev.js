// Servidor local (desenvolvimento). Na Vercel o app roda via api/index.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { app } from './http.js';

const PORT = Number(process.env.PORT || 3000);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.use(express.static(root));
app.get('*', (req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(PORT, () => {
  console.log(`Pulse Direct · Gestão de Pausas em http://localhost:${PORT}`);
  if (process.env.DRY_RUN === 'true') console.log('Modo DRY_RUN: o status no Pulse Direct NÃO será alterado.');
});
