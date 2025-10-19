const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const cors = require("cors");
const cron = require("node-cron");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

let atualizandoParcelas = false;

async function atualizarParcelasAtrasadas() {
  if (atualizandoParcelas) return;

  atualizandoParcelas = true;

  try {
    const hoje = new Date().toISOString().split("T")[0];

    await pool.query(
      `UPDATE parcelas 
       SET status = 'Atrasada' 
       WHERE status = 'Pendente' AND data_vencimento < ?`,
      [hoje]
    );

    await pool.query(
      `UPDATE emprestimos e
       JOIN parcelas p ON e.id = p.id_emprestimo
       SET e.statos = 'Em Atraso'
       WHERE p.status = 'Atrasada'`
    );

    await pool.query(
      `UPDATE clientes c
       JOIN emprestimos e ON e.cliente = c.nome
       JOIN parcelas p ON p.id_emprestimo = e.id
       SET c.atrasos = (
         SELECT COUNT(*)
         FROM parcelas p2
         JOIN emprestimos e2 ON p2.id_emprestimo = e2.id
         WHERE e2.cliente = c.nome AND p2.status = 'Atrasada'
       )`
    );

    await pool.query(
      `UPDATE clientes c
       JOIN emprestimos e ON e.cliente = c.nome
       SET c.emprestimos_atrasados = (
         SELECT COUNT(DISTINCT e2.id)
         FROM emprestimos e2
         JOIN parcelas p2 ON p2.id_emprestimo = e2.id
         WHERE e2.cliente = c.nome AND p2.status = 'Atrasada'
       )`
    );

    console.log("Parcelas e clientes atrasados atualizados automaticamente.");
  } catch (err) {
    console.error("Erro ao atualizar parcelas atrasadas automaticamente:", err);
  } finally {
    setTimeout(() => {
      atualizandoParcelas = false;
    }, 500);
  }
}


cron.schedule("1 0 * * *", () => {
  atualizarParcelasAtrasadas();
});

async function atualizarParcelasMiddleware(req, res, next) {
  try {
    await atualizarParcelasAtrasadas();
  } catch (err) {
    console.error("Erro ao atualizar parcelas atrasadas via middleware:", err);
  }
  next();
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE username = ?", [username]);
    if (rows.length === 0) return res.status(400).json({ error: "Usuário ou senha inválidos" });
    const user = rows[0];
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: "Usuário ou senha inválidos" });
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: "Erro no servidor" });
  }
});

function autenticar(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token necessário" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}

app.post("/clientes", autenticar, async (req, res) => {
  const { nome, telefone, endereco, indicado, obs } = req.body;
  try {
    const [existe] = await pool.query(
      "SELECT id FROM clientes WHERE nome = ?",
      [nome]
    );

    if (existe.length > 0) {
      return res.status(400).json({ error: "Já existe um cliente com esse nome." });
    }

    const [result] = await pool.query(
      "INSERT INTO clientes (nome, telefone, endereco, indicado, obs) VALUES (?, ?, ?, ?, ?)",
      [nome, telefone, endereco, indicado, obs || ""]
    );

    const [clienteBase] = await pool.query(
      `SELECT id, nome, telefone, endereco, indicado, datacadastro, obs 
       FROM clientes WHERE id = ?`,
      [result.insertId]
    );

    const cliente = clienteBase[0];

    const [emprestimos] = await pool.query(
      "SELECT * FROM emprestimos WHERE cliente = ?",
      [cliente.nome]
    );

    const total_emprestimos_feitos = emprestimos.length;
    const emprestimos_pendentes = emprestimos.filter(e => e.statos === "pendente").length;
    const emprestimos_pagos = emprestimos.filter(e => e.statos === "pago").length;
    const total_valor_emprestado = emprestimos.reduce((acc, e) => acc + Number(e.valoremprestado), 0);
    const lucro_total = emprestimos.reduce((acc, e) => acc + (Number(e.valorpagar) - Number(e.valoremprestado)), 0);
    const maior_valor_emprestado = emprestimos.reduce((acc, e) => Math.max(acc, Number(e.valoremprestado)), 0);
    const atrasos = emprestimos.filter(e => e.statos === "atrasado").length;

    res.json({
      ...cliente,
      total_emprestimos_feitos,
      emprestimos_pendentes,
      emprestimos_pagos,
      total_valor_emprestado,
      lucro_total,
      maior_valor_emprestado,
      atrasos
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cadastrar cliente" });
  }
});

app.get("/clientes", autenticar, async (req, res) => {
  try {
    const [clientes] = await pool.query(
      `SELECT id, nome, telefone, indicado, total_emprestimos_feitos, emprestimos_pendentes, total_valor_emprestado, lucro_total, atrasos, maior_valor_emprestado, endereco, datacadastro, emprestimos_pagos, emprestimos_atrasados, obs
       FROM clientes`
    );
    res.json(clientes);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar clientes" });
  }
});

app.put("/obs/:id", autenticar, async (req, res) => {
  const { id } = req.params;
  const { obs } = req.body;

  try {
    await pool.query(
      `UPDATE clientes 
       SET obs = ?
       WHERE id = ?`,
      [obs, id]
    );
    res.json({ message: "OBS do Cliente atualizado com sucesso!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao editar obs do cliente" });
  }
});


app.put("/clientes/:id", autenticar, async (req, res) => {
  const { id } = req.params;
  const { nome, telefone, endereco, indicado, obs } = req.body;

  try {
    await pool.query(
      `UPDATE clientes 
       SET nome = ?, telefone = ?, endereco = ?, indicado = ?, obs = ?
       WHERE id = ?`,
      [nome, telefone, endereco, indicado, obs, id]
    );

    res.json({ message: "Cliente atualizado com sucesso!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao editar cliente" });
  }
});


app.delete("/clientes/:id", autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const [clienteRows] = await pool.query(
      "SELECT nome FROM clientes WHERE id = ?",
      [id]
    );

    if (clienteRows.length === 0) {
      return res.status(404).json({ error: "Cliente não encontrado" });
    }

    const nomeCliente = clienteRows[0].nome;

    const [emprestimos] = await pool.query(
      "SELECT id FROM emprestimos WHERE cliente = ?",
      [nomeCliente]
    );

    if (emprestimos.length > 0) {
      const emprestimosIds = emprestimos.map((e) => e.id);

      await pool.query(
        `DELETE FROM parcelas WHERE id_emprestimo IN (${emprestimosIds.join(",")})`
      );

      await pool.query(
        "DELETE FROM emprestimos WHERE cliente = ?",
        [nomeCliente]
      );
    }

    await pool.query(
      "DELETE FROM clientes WHERE id = ?",
      [id]
    );

    res.json({ message: "Cliente e todos os empréstimos/parcelas removidos com sucesso!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao apagar cliente" });
  }
});

app.get("/clientes/quantidade", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`SELECT COUNT(*) AS total FROM clientes`);
    res.json({ totalClientes: result[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar clientes" });
  }
});

app.get("/emprestimos/quantidade", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT COUNT(*) AS total 
      FROM emprestimos
      WHERE statos IN ('Pendente', 'Em Atraso')
    `);
    res.json({ totalEmprestimos: result[0].total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao contar empréstimos" });
  }
});

app.get("/emprestimos/ematraso", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT COUNT(DISTINCT p.id_emprestimo) AS total
      FROM parcelas p
      WHERE p.status = 'Atrasada'
    `);

    res.json({ totalEmprestimosAtrasados: result[0].total });
  } catch (err) {
    console.error("Erro ao buscar empréstimos em atraso:", err);
    res.status(500).json({ error: "Erro ao buscar empréstimos em atraso" });
  }
});

app.get("/caixinha/total", autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT SUM(valor) AS totalCaixinha FROM caixinha");
    const total = rows[0].totalCaixinha || 0;
    res.json({ totalCaixinha: total });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar total do caixinha" });
  }
});

app.get("/validar-token", (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  console.log("Token recebido:", token);
  console.log("JWT_SECRET atual:", process.env.JWT_SECRET);

  if (!token) {
    return res.json({ valido: false });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log("Token inválido:", err.message);
      return res.json({ valido: false });
    }

    console.log("Token válido para usuário:", user);
    res.json({ valido: true, usuario: user });
  });
});



app.put("/caixinha", autenticar, async (req, res) => {
  try {
    const { valor } = req.body;

    if (typeof valor !== "number") {
      return res.status(400).json({ error: "O valor deve ser um número." });
    }

    const [result] = await pool.query(
      "UPDATE caixinha SET valor = valor + ? LIMIT 1",
      [valor]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Caixinha não encontrado." });
    }

    const [rows] = await pool.query("SELECT valor FROM caixinha LIMIT 1");

    res.json({ message: "Valor atualizado com sucesso!", caixinha: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao atualizar caixinha." });
  }
});

app.put("/emprestimos/:id", autenticar, async (req, res) => {
  const { id } = req.params;
  const { cliente, valoremprestado, valorpagar, parcelas, dataemprestimo, obs } = req.body;

  if (!cliente || !valoremprestado || !valorpagar || !parcelas || !dataemprestimo) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {
    const [clienteExistente] = await pool.query(
      "SELECT id FROM clientes WHERE nome = ?",
      [cliente]
    );

    if (clienteExistente.length === 0) {
      return res.status(400).json({ error: "Cliente não encontrado." });
    }

    const clienteId = clienteExistente[0].id;

    const [emprestimoExistenteArr] = await pool.query(
      "SELECT * FROM emprestimos WHERE id = ?",
      [id]
    );

    if (emprestimoExistenteArr.length === 0) {
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    }

    const emprestimoExistente = emprestimoExistenteArr[0];
    const numeroParcelasAntigo = emprestimoExistente.parcelas;

    await pool.query(
      `UPDATE emprestimos SET 
         cliente = ?, 
         valoremprestado = ?, 
         valorpagar = ?, 
         parcelas = ?, 
         dataemprestimo = ?, 
         obs = ? 
       WHERE id = ?`,
      [cliente, valoremprestado, valorpagar, parcelas, dataemprestimo, obs || "", id]
    );

    const valorParcela = parseFloat(valorpagar) / parseInt(parcelas);

    const [parcelasExistentes] = await pool.query(
      "SELECT * FROM parcelas WHERE id_emprestimo = ? ORDER BY numero_parcela ASC",
      [id]
    );

    if (parcelas < numeroParcelasAntigo) {
      const parcelasParaRemover = numeroParcelasAntigo - parcelas;
      const ultimasParcelas = parcelasExistentes
        .slice(-parcelasParaRemover)
        .map(p => p.id);

      if (ultimasParcelas.length > 0) {
        await pool.query(
          `DELETE FROM parcelas WHERE id IN (${ultimasParcelas.join(",")})`
        );
      }
    }

    if (parcelas > numeroParcelasAntigo) {
      const dataBase = new Date(dataemprestimo);
      const novasParcelasPromises = [];
      for (let i = numeroParcelasAntigo + 1; i <= parcelas; i++) {
        const dataVencimento = new Date(dataBase);
        dataVencimento.setMonth(dataBase.getMonth() + i);

        novasParcelasPromises.push(
          pool.query(
            `INSERT INTO parcelas 
               (id_emprestimo, numero_parcela, valor_parcela, data_vencimento, data_pagamento, status)
               VALUES (?, ?, ?, ?, ?, ?)`,
            [
              id,
              i,
              valorParcela.toFixed(2),
              dataVencimento.toISOString().split("T")[0],
              null,
              "Pendente"
            ]
          )
        );
      }
      await Promise.all(novasParcelasPromises);
    }

    const parcelasParaAtualizar = await pool.query(
      "SELECT id FROM parcelas WHERE id_emprestimo = ? ORDER BY numero_parcela ASC",
      [id]
    );

    const updatePromises = parcelasParaAtualizar[0].map(p =>
      pool.query("UPDATE parcelas SET valor_parcela = ? WHERE id = ?", [
        valorParcela.toFixed(2),
        p.id
      ])
    );

    await Promise.all(updatePromises);

    const [emprestimoAtualizadoArr] = await pool.query(
      "SELECT * FROM emprestimos WHERE id = ?",
      [id]
    );

    const emprestimoAtualizado = emprestimoAtualizadoArr[0];

    res.json(emprestimoAtualizado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar empréstimo." });
  }
});



app.get("/emprestimos/pagos", autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT *
      FROM emprestimos
      WHERE statos = 'Pago'
    `);

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar empréstimos pagos:", err);
    res.status(500).json({ error: "Erro ao buscar empréstimos pagos" });
  }
});

app.patch("/emprestimos/:id/pago", autenticar, async (req, res) => {
  const { id } = req.params;

  try {

    const [naoPagas] = await pool.query(
      `SELECT COUNT(*) AS qtd 
       FROM parcelas 
       WHERE id_emprestimo = ? 
         AND status != 'Pago'`,
      [id]
    );

    if (naoPagas[0].qtd > 0) {
      return res.status(400).json({
        error: "Ainda existem parcelas pendentes ou atrasadas. Quite todas antes de finalizar o empréstimo.",
      });
    }

    await pool.query(
      `UPDATE emprestimos 
       SET statos = 'Pago' 
       WHERE id = ?`,
      [id]
    );

    res.json({ success: true, message: "Empréstimo marcado como Pago com sucesso." });
  } catch (err) {
    console.error("Erro ao marcar empréstimo como pago:", err);
    res.status(500).json({ error: "Erro ao marcar empréstimo como pago." });
  }
});

app.get("/emprestimos", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [emprestimos] = await pool.query(
      `SELECT e.*, e.obs AS observacoes, c.id AS id_cliente
       FROM emprestimos e
       JOIN clientes c ON e.cliente = c.nome
       WHERE e.statos IN ('Pendente', 'Em Atraso')
       ORDER BY e.id DESC`
    );
    res.json(emprestimos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar empréstimos." });
  }
});

app.post("/emprestimos", autenticar, async (req, res) => {
  const { cliente, valoremprestado, valorpagar, parcelas, dataemprestimo, obs } = req.body;

  if (!cliente || !valoremprestado || !valorpagar || !parcelas || !dataemprestimo) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  try {
    const [clienteExistente] = await pool.query(
      "SELECT id FROM clientes WHERE nome = ?",
      [cliente]
    );

    if (clienteExistente.length === 0) {
      return res.status(400).json({ error: "Cliente não encontrado." });
    }

    const clienteId = clienteExistente[0].id;
    const hoje = new Date();
    const dataEmp = new Date(dataemprestimo);

    const statusEmprestimo = "Pendente";

    const [result] = await pool.query(
      `INSERT INTO emprestimos (cliente, valoremprestado, valorpagar, parcelas, dataemprestimo, obs, statos)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cliente, valoremprestado, valorpagar, parcelas, dataemprestimo, obs || "", statusEmprestimo]
    );

    const emprestimoId = result.insertId;
    const valorParcela = parseFloat(valorpagar) / parseInt(parcelas);
    const dataBase = new Date(dataemprestimo);
    const parcelasPromises = [];

    for (let i = 1; i <= parcelas; i++) {
      const dataVencimento = new Date(dataBase);
      dataVencimento.setMonth(dataBase.getMonth() + i);
      const statusParcela = dataVencimento < hoje ? "Atrasada" : "Pendente";

      parcelasPromises.push(
        pool.query(
          `INSERT INTO parcelas (id_emprestimo, numero_parcela, valor_parcela, data_vencimento, status)
           VALUES (?, ?, ?, ?, ?)`,
          [emprestimoId, i, valorParcela.toFixed(2), dataVencimento.toISOString().split("T")[0], statusParcela]
        )
      );
    }

    await Promise.all(parcelasPromises);

    const [temAtraso] = await pool.query(
      `SELECT COUNT(*) AS qtd FROM parcelas WHERE id_emprestimo = ? AND status = 'Atrasada'`,
      [emprestimoId]
    );
    if (temAtraso[0].qtd > 0) {
      await pool.query(`UPDATE emprestimos SET statos = 'Em Atraso' WHERE id = ?`, [emprestimoId]);
    }

    await pool.query(`
      UPDATE clientes c
      SET
        total_emprestimos_feitos = (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome),
        emprestimos_pendentes = (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome AND e.statos = 'Pendente'),
        emprestimos_pagos = (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome AND e.statos = 'Pago'),
        total_valor_emprestado = (SELECT IFNULL(SUM(e.valoremprestado),0) FROM emprestimos e WHERE e.cliente = c.nome),
        lucro_total = (
          SELECT IFNULL(SUM(
            ((e.valorpagar - e.valoremprestado) / e.parcelas) *
            (SELECT COUNT(*) FROM parcelas p2 WHERE p2.id_emprestimo = e.id AND p2.status = 'Pago')
          ),0)
          FROM emprestimos e
          WHERE e.cliente = c.nome
        ),
        maior_valor_emprestado = (SELECT IFNULL(MAX(e.valoremprestado),0) FROM emprestimos e WHERE e.cliente = c.nome),
        emprestimos_atrasados = (
          SELECT COUNT(DISTINCT e.id)
          FROM emprestimos e
          JOIN parcelas p ON e.id = p.id_emprestimo
          WHERE e.cliente = c.nome
            AND p.status = 'Atrasada'
            AND p.data_vencimento < NOW()
        ),
        atrasos = (
          SELECT COUNT(*)
          FROM parcelas p
          JOIN emprestimos e ON e.id = p.id_emprestimo
          WHERE e.cliente = c.nome
            AND p.status = 'Atrasada'
            AND p.data_vencimento < NOW()
        )
      WHERE c.id = ?
    `, [clienteId]);

    const [novoEmprestimo] = await pool.query(
      "SELECT * FROM emprestimos WHERE id = ?",
      [emprestimoId]
    );

    res.json(novoEmprestimo[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar empréstimo." });
  }
});



app.get("/clientes/stats/:id", autenticar, async (req, res) => {
  const clienteId = req.params.id;

  try {
    const [stats] = await pool.query(`
      SELECT 
        c.id,
        c.nome,
        c.telefone,
        c.endereco,
        c.indicado,
        c.datacadastro,
        c.obs,

        -- Contagem de empréstimos
        (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome) AS total_emprestimos_feitos,

        -- Empréstimos pendentes
        (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome AND e.statos = 'Pendente') AS emprestimos_pendentes,

        -- Empréstimos pagos
        (SELECT COUNT(*) FROM emprestimos e WHERE e.cliente = c.nome AND e.statos = 'Pago') AS emprestimos_pagos,

        -- Total valor emprestado
        (SELECT IFNULL(SUM(e.valoremprestado),0) FROM emprestimos e WHERE e.cliente = c.nome) AS total_valor_emprestado,

        -- Lucro total calculado
        (SELECT IFNULL(SUM(
          ((e.valorpagar - e.valoremprestado) / e.parcelas) *
          (SELECT COUNT(*) FROM parcelas p2 WHERE p2.id_emprestimo = e.id AND p2.status = 'Pago')
        ),0)
        FROM emprestimos e 
        WHERE e.cliente = c.nome) AS lucro_total,

        -- Maior valor emprestado
        (SELECT IFNULL(MAX(e.valoremprestado),0) FROM emprestimos e WHERE e.cliente = c.nome) AS maior_valor_emprestado,

        -- Empréstimos atrasados (conta empréstimos com ao menos uma parcela vencida)
        (
          SELECT COUNT(DISTINCT e.id)
          FROM emprestimos e
          JOIN parcelas p ON e.id = p.id_emprestimo
          WHERE e.cliente = c.nome
            AND p.status = 'Atrasada'
            AND p.data_vencimento < NOW()
        ) AS emprestimos_atrasados

      FROM clientes c
      WHERE c.id = ?
    `, [clienteId]);

    if (stats.length === 0) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }

    res.json(stats[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar estatísticas do cliente." });
  }
});


app.get("/emprestimos/:id/proximasParcelas", async (req, res) => {
  const id = req.params.id;

  try {
    const [rows] = await pool.query(
      "SELECT * FROM parcelas WHERE id_emprestimo = ? ORDER BY data_vencimento ASC",
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar próximas parcelas:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});


app.get("/emprestimos/juros", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [emprestimos] = await pool.query(
      `SELECT e.id, e.cliente, e.valoremprestado, e.valorpagar,
              c.id AS id_cliente
       FROM emprestimos e
       JOIN clientes c ON e.cliente = c.nome
       ORDER BY e.id DESC`
    );

    const emprestimosComJuros = emprestimos.map((e) => {
      const valorEmprestado = parseFloat(e.valoremprestado);
      const valorPagar = parseFloat(e.valorpagar);
      const juros = valorPagar - valorEmprestado;
      const porcentagem = (juros / valorEmprestado) * 100;

      return {
        ...e,
        juros: juros.toFixed(2),
        porcentagem: porcentagem.toFixed(2) + "%",
      };
    });

    res.json(emprestimosComJuros);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao calcular juros dos empréstimos." });
  }
});

app.get("/emprestimos/resumo/:id", autenticar, async (req, res) => {
  const emprestimoId = req.params.id;

  try {
    const [emprestimos] = await pool.query(
      "SELECT *, obs AS observacoes FROM emprestimos WHERE id = ?",
      [emprestimoId]
    );

    if (emprestimos.length === 0) {
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    }

    const emprestimo = emprestimos[0];

    const [parcelas] = await pool.query(
      "SELECT * FROM parcelas WHERE id_emprestimo = ? ORDER BY numero_parcela ASC",
      [emprestimoId]
    );

    const parcelasPagas = parcelas.filter(p => p.status === "Pago").length;
    const parcelasPendentes = parcelas.filter(p => p.status === "Pendente").length;
    const parcelasAtrasadas = parcelas.filter(p => p.status === "Atrasada").length;
    const valorParcela = parcelas.length > 0 ? parseFloat(parcelas[0].valor_parcela) : 0;
    const valorJaPago = parcelas
      .filter(p => p.status === "Pago")
      .reduce((acc, p) => acc + parseFloat(p.valor_parcela), 0);
    const valorPendente = parcelas
      .filter(p => p.status === "Pendente")
      .reduce((acc, p) => acc + parseFloat(p.valor_parcela), 0);

    const proximoVencimentoObj = parcelas.find(p => p.status === "Pendente");
    const proximoVencimento = proximoVencimentoObj ? proximoVencimentoObj.data_vencimento : null;

    res.json({
      parcelasPagas,
      parcelasPendentes,
      parcelasAtrasadas,
      valorParcela: valorParcela.toFixed(2),
      valorJaPago: valorJaPago.toFixed(2),
      valorPendente: valorPendente.toFixed(2),
      proximoVencimento
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar resumo do empréstimo." });
  }
});

app.get("/parcelas", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  const { id_emprestimo, cliente } = req.query;
  try {
    let query = `
      SELECT p.id, p.id_emprestimo, p.numero_parcela, p.valor_parcela, p.data_vencimento, p.data_pagamento, p.status,
             e.cliente, e.parcelas AS total_parcelas
      FROM parcelas p
      JOIN emprestimos e ON p.id_emprestimo = e.id
      WHERE 1=1
    `;
    const params = [];
    if (id_emprestimo) {
      query += " AND p.id_emprestimo = ?";
      params.push(id_emprestimo);
    }
    if (cliente) {
      query += " AND e.cliente = ?";
      params.push(cliente);
    }
    query += " ORDER BY p.numero_parcela ASC";

    const [parcelas] = await pool.query(query, params);
    res.json(parcelas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar parcelas." });
  }
});

app.get("/resumo-mensal/:ano/:mes", autenticar, async (req, res) => {
  const { ano, mes } = req.params;

  try {
    // -------------------
    // INVESTIMENTO
    // -------------------
    const [investRows] = await pool.query(
      `SELECT COALESCE(SUM(valoremprestado), 0) AS investimento
       FROM emprestimos
       WHERE YEAR(dataemprestimo) = ? AND MONTH(dataemprestimo) = ?`,
      [ano, mes]
    );

    const investimento = parseFloat(investRows[0].investimento) || 0;

    // -------------------
    // LUCRO
    // -------------------
    const [lucroRows] = await pool.query(
      `SELECT e.id, e.valorpagar, e.valoremprestado, e.parcelas
       FROM parcelas p
       JOIN emprestimos e ON p.id_emprestimo = e.id
       WHERE p.status = 'Pago'
         AND YEAR(p.data_pagamento) = ? 
         AND MONTH(p.data_pagamento) = ?`,
      [ano, mes]
    );

    let lucro = 0;
    for (const row of lucroRows) {
      const { valorpagar, valoremprestado, parcelas } = row;
      const lucroParcela = (valorpagar - valoremprestado) / parcelas;
      lucro += lucroParcela;
    }

    res.json({
      ano,
      mes,
      investimento: investimento.toFixed(2),
      lucro: lucro.toFixed(2),
    });
  } catch (err) {
    console.error("Erro ao calcular resumo mensal:", err);
    res.status(500).json({ error: "Erro ao calcular resumo mensal." });
  }
});

app.patch("/parcelas/:idParcela/status", autenticar, async (req, res) => {
  const { idParcela } = req.params;
  const { status } = req.body;

  if (!["Pago", "Pendente"].includes(status)) {
    return res.status(400).json({ error: "Status inválido." });
  }

  try {
    let statusAtualizadoParcela;

    if (status === "Pago") {
      await pool.query(
        "UPDATE parcelas SET status = ?, data_pagamento = NOW() WHERE id = ?",
        [status, idParcela]
      );
      statusAtualizadoParcela = "Pago";
    } else {
      const [rows] = await pool.query(
        "SELECT data_vencimento FROM parcelas WHERE id = ?",
        [idParcela]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Parcela não encontrada." });
      }

      const dataVencimento = new Date(rows[0].data_vencimento);
      const hoje = new Date();
      dataVencimento.setHours(0, 0, 0, 0);
      hoje.setHours(0, 0, 0, 0);

      statusAtualizadoParcela = dataVencimento < hoje ? "Atrasada" : "Pendente";

      await pool.query(
        "UPDATE parcelas SET status = ?, data_pagamento = NULL WHERE id = ?",
        [statusAtualizadoParcela, idParcela]
      );
    }

    const [parcela] = await pool.query(
      "SELECT id_emprestimo FROM parcelas WHERE id = ?",
      [idParcela]
    );
    if (parcela.length === 0) return res.status(404).json({ error: "Parcela não encontrada." });

    const idEmprestimo = parcela[0].id_emprestimo;

    const [parcelasEmprestimo] = await pool.query(
      "SELECT status FROM parcelas WHERE id_emprestimo = ?",
      [idEmprestimo]
    );

    let novoStatusEmprestimo = "Pendente";
    if (parcelasEmprestimo.some(p => p.status === "Atrasada")) {
      novoStatusEmprestimo = "Em Atraso";
    }

    await pool.query(
      "UPDATE emprestimos SET statos = ? WHERE id = ?",
      [novoStatusEmprestimo, idEmprestimo]
    );

    const [emprestimo] = await pool.query(
      "SELECT cliente, valorpagar, valoremprestado, parcelas FROM emprestimos WHERE id = ?",
      [idEmprestimo]
    );

    if (emprestimo.length > 0) {
      const { cliente, valorpagar, valoremprestado, parcelas } = emprestimo[0];
      const lucroParcela = (valorpagar - valoremprestado) / parcelas;

      if (status === "Pago") {
        const [restantesAtrasadas] = await pool.query(
          "SELECT COUNT(*) AS qtd FROM parcelas WHERE id_emprestimo = ? AND status = 'Atrasada'",
          [idEmprestimo]
        );

        if (restantesAtrasadas[0].qtd === 0) {
          await pool.query(
            "UPDATE clientes SET emprestimos_atrasados = GREATEST(emprestimos_atrasados - 1, 0) WHERE id = ?",
            [cliente]
          );
        }

        await pool.query(
          "UPDATE clientes SET lucro_total = lucro_total + ? WHERE id = ?",
          [lucroParcela, cliente]
        );
      } else if (statusAtualizadoParcela === "Pendente" || statusAtualizadoParcela === "Atrasada") {
        await pool.query(
          "UPDATE clientes SET lucro_total = GREATEST(lucro_total - ?, 0) WHERE id = ?",
          [lucroParcela, cliente]
        );
      }
    }

    res.json({
      message: "Parcela, status do empréstimo e cliente atualizados com sucesso.",
      statusParcela: statusAtualizadoParcela,
      statusEmprestimo: novoStatusEmprestimo
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar status da parcela." });
  }
});

app.delete("/emprestimos/:id", autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const [emprestimoRows] = await pool.query(
      "SELECT * FROM emprestimos WHERE id = ?",
      [id]
    );

    if (emprestimoRows.length === 0) {
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    }

    const emprestimo = emprestimoRows[0];

    const [clienteRows] = await pool.query(
      "SELECT * FROM clientes WHERE nome = ?",
      [emprestimo.cliente]
    );
    if (clienteRows.length === 0) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }
    const cliente = clienteRows[0];

    const [parcelas] = await pool.query(
      "SELECT * FROM parcelas WHERE id_emprestimo = ?",
      [id]
    );

    const parcelasPagas = parcelas.filter(p => p.status === "Pago").length;

    const lucroPorParcela = (emprestimo.valorpagar - emprestimo.valoremprestado) / emprestimo.parcelas;

    const lucroGerado = lucroPorParcela * parcelasPagas;

    let novosValores = {
      total_emprestimos_feitos: Math.max(cliente.total_emprestimos_feitos - 1, 0),
      total_valor_emprestado: Math.max(cliente.total_valor_emprestado - emprestimo.valoremprestado, 0),
      emprestimos_pendentes: cliente.emprestimos_pendentes,
      emprestimos_pagos: cliente.emprestimos_pagos,
      emprestimos_atrasados: cliente.emprestimos_atrasados,
      atrasos: cliente.atrasos,
      lucro_total: Math.max(cliente.lucro_total - lucroGerado, 0),
      maior_valor_emprestado: cliente.maior_valor_emprestado
    };

    if (emprestimo.statos === "Pendente" || emprestimo.statos === "Em Atraso") {
      novosValores.emprestimos_pendentes = Math.max(cliente.emprestimos_pendentes - 1, 0);
    }

    if (emprestimo.statos === "Pago") {
      novosValores.emprestimos_pagos = Math.max(cliente.emprestimos_pagos - 1, 0);
    }

    const parcelasAtrasadas = parcelas.filter(p => p.status === "Atrasada").length;
    if (parcelasAtrasadas > 0) {
      novosValores.atrasos = Math.max(cliente.atrasos - parcelasAtrasadas, 0);
      novosValores.emprestimos_atrasados = Math.max(cliente.emprestimos_atrasados - 1, 0);
    }

    if (emprestimo.valoremprestado === cliente.maior_valor_emprestado) {
      const [novoMaior] = await pool.query(
        "SELECT MAX(valoremprestado) AS maximo FROM emprestimos WHERE cliente = ? AND id <> ?",
        [emprestimo.cliente, id]
      );
      novosValores.maior_valor_emprestado = novoMaior[0].maximo || 0;
    }

    await pool.query(
      `UPDATE clientes 
       SET total_emprestimos_feitos = ?, 
           emprestimos_pendentes = ?, 
           emprestimos_pagos = ?,
           emprestimos_atrasados = ?, 
           total_valor_emprestado = ?, 
           lucro_total = ?, 
           atrasos = ?, 
           maior_valor_emprestado = ?
       WHERE id = ?`,
      [
        novosValores.total_emprestimos_feitos,
        novosValores.emprestimos_pendentes,
        novosValores.emprestimos_pagos,
        novosValores.emprestimos_atrasados,
        novosValores.total_valor_emprestado,
        novosValores.lucro_total,
        novosValores.atrasos,
        novosValores.maior_valor_emprestado,
        cliente.id
      ]
    );

    await pool.query("DELETE FROM parcelas WHERE id_emprestimo = ?", [id]);
    await pool.query("DELETE FROM emprestimos WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Empréstimo removido e cliente atualizado com sucesso."
    });
  } catch (err) {
    console.error("Erro ao apagar empréstimo:", err);
    res.status(500).json({ error: "Erro ao apagar empréstimo." });
  }
});





app.get("/parcelas/hoje", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [parcelas] = await pool.query(
      `SELECT p.*, e.cliente, e.parcelas AS totalParcelas
       FROM parcelas p
       JOIN emprestimos e ON e.id = p.id_emprestimo
       WHERE DATE(p.data_vencimento) = CURDATE() AND p.status != 'Pago'
       ORDER BY p.data_vencimento ASC`
    );

    res.json(parcelas);
  } catch (err) {
    console.error("Erro ao buscar parcelas de hoje:", err);
    res.status(500).json({ error: "Erro ao buscar parcelas de hoje" });
  }
});

app.get("/parcelas/mes", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [parcelas] = await pool.query(
      `SELECT p.*, e.cliente, e.parcelas AS totalParcelas
       FROM parcelas p
       JOIN emprestimos e ON e.id = p.id_emprestimo
       WHERE p.status != 'Pago' 
         AND MONTH(p.data_vencimento) = MONTH(CURDATE())
         AND YEAR(p.data_vencimento) = YEAR(CURDATE())
         AND p.data_vencimento >= CURDATE()
       ORDER BY p.data_vencimento ASC`
    );

    res.json(parcelas);
  } catch (err) {
    console.error("Erro ao buscar parcelas do mês:", err);
    res.status(500).json({ error: "Erro ao buscar parcelas do mês" });
  }
});

app.get("/parcelas/atrasadas", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [parcelas] = await pool.query(
      `SELECT p.*, e.cliente, e.parcelas AS totalParcelas
       FROM parcelas p
       JOIN emprestimos e ON e.id = p.id_emprestimo
       WHERE p.status = 'Atrasada'
       ORDER BY p.data_vencimento ASC`
    );

    res.json(parcelas);
  } catch (err) {
    console.error("Erro ao buscar parcelas atrasadas:", err);
    res.status(500).json({ error: "Erro ao buscar parcelas atrasadas" });
  }
});

app.get("/parcelas/clientes-hoje", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT COUNT(DISTINCT e.cliente) AS totalClientesHoje
       FROM parcelas p
       JOIN emprestimos e ON p.id_emprestimo = e.id
       WHERE p.status != 'Pago'
         AND DATE(p.data_vencimento) = CURDATE()`
    );
    res.json({ totalClientesHoje: result[0].totalClientesHoje });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar clientes com pagamentos para hoje" });
  }
});

app.get("/parcelas/clientes-mes", autenticar, atualizarParcelasMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT COUNT(DISTINCT e.cliente) AS totalClientesMes
       FROM parcelas p
       JOIN emprestimos e ON p.id_emprestimo = e.id
       WHERE p.status != 'Pago'
         AND MONTH(p.data_vencimento) = MONTH(CURDATE())
         AND YEAR(p.data_vencimento) = YEAR(CURDATE())`
    );
    res.json({ totalClientesMes: result[0].totalClientesMes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar clientes com pagamentos neste mês" });
  }
});

app.get("/parcelas/pagas-hoje", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT COUNT(*) AS totalPagasHoje
      FROM parcelas
      WHERE DATE(data_pagamento) = CURDATE()
    `);

    res.json({ totalPagasHoje: result[0].totalPagasHoje });
  } catch (err) {
    console.error("Erro ao buscar parcelas pagas hoje:", err);
    res.status(500).json({ error: "Erro ao buscar parcelas pagas hoje" });
  }
});

app.get("/emprestimos/total-emprestado", autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT COALESCE(SUM(remaining_principal), 0) AS totalPrincipalRemaining FROM (
        SELECT 
          e.id,
          e.valoremprestado,
          e.parcelas,
          COUNT(p.id) AS unpaid_count,
          (e.valoremprestado / NULLIF(e.parcelas, 0)) * COUNT(p.id) AS remaining_principal
        FROM emprestimos e
        LEFT JOIN parcelas p
          ON p.id_emprestimo = e.id
          AND p.status IN ('Pendente', 'Atrasada')
        WHERE e.statos IN ('Pendente', 'Em Atraso')
        GROUP BY e.id, e.valoremprestado, e.parcelas
      ) t;
    `);

    const total = parseFloat(rows[0].totalPrincipalRemaining) || 0;
    res.json({ totalValorEmprestado: total });
  } catch (err) {
    console.error("Erro ao buscar empréstimos pendentes ou em atraso:", err);
    res.status(500).json({ error: "Erro ao buscar empréstimos pendentes ou em atraso" });
  }
});


app.get("/emprestimos/total-investimento-acumulado", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT SUM(valoremprestado) AS totalInvestimentoAcumulado
      FROM emprestimos
      WHERE statos IN ('Pendente', 'Em Atraso', 'Pago')
    `);

    res.json({ totalInvestimentoAcumulado: result[0].totalInvestimentoAcumulado || 0 });
  } catch (err) {
    console.error("Erro ao buscar empréstimos Com Investimentos Acumulados:", err);
    res.status(500).json({ error: "Erro ao buscar empréstimos Com Investimentos Acumulados" });
  }
});

app.get("/emprestimos/total-emprestado-mes", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT SUM(valoremprestado) AS totalValorEmprestadoMes
      FROM emprestimos
      WHERE MONTH(dataemprestimo) = MONTH(CURDATE())
        AND YEAR(dataemprestimo) = YEAR(CURDATE())
    `);

    res.json({ totalValorEmprestadoMes: result[0].totalValorEmprestadoMes || 0 });
  } catch (err) {
    console.error("Erro ao buscar total de empréstimos do mês:", err);
    res.status(500).json({ error: "Erro ao buscar total de empréstimos do mês" });
  }
});

app.get("/emprestimos/total-emprestado-hoje", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT SUM(valoremprestado) AS totalValorEmprestadoHoje
      FROM emprestimos
      WHERE DATE(dataemprestimo) = CURDATE()
    `);

    res.json({ totalValorEmprestadoHoje: result[0].totalValorEmprestadoHoje || 0 });
  } catch (err) {
    console.error("Erro ao buscar total de empréstimos de hoje:", err);
    res.status(500).json({ error: "Erro ao buscar total de empréstimos de hoje" });
  }
});

app.get("/emprestimos/lucro-total-a-receber", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT 
        SUM(( (e.valorpagar - e.valoremprestado) / e.parcelas )) AS lucroTotalAReceber
      FROM emprestimos e
      JOIN parcelas p ON p.id_emprestimo = e.id
      WHERE e.statos IN ('Pendente', 'Em Atraso')
        AND p.status IN ('Pendente', 'Atrasada')
    `);

    res.json({ lucroTotalAReceber: result[0].lucroTotalAReceber || 0 });
  } catch (err) {
    console.error("Erro ao calcular lucro total a receber:", err);
    res.status(500).json({ error: "Erro ao calcular lucro total a receber" });
  }
});

app.get("/emprestimos/lucro-total-a-receber-mes", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT 
        SUM(( (e.valorpagar - e.valoremprestado) / e.parcelas )) AS lucroTotalAReceberMes
      FROM emprestimos e
      JOIN parcelas p ON p.id_emprestimo = e.id
      WHERE e.statos IN ('Pendente', 'Em Atraso')
        AND p.status IN ('Pendente', 'Atrasada')
        AND MONTH(p.data_vencimento) = MONTH(CURDATE())
        AND YEAR(p.data_vencimento) = YEAR(CURDATE())
    `);

    res.json({ lucroTotalAReceberMes: result[0].lucroTotalAReceberMes || 0 });
  } catch (err) {
    console.error("Erro ao calcular lucro total a receber do mês:", err);
    res.status(500).json({ error: "Erro ao calcular lucro total a receber do mês" });
  }
});

app.get("/emprestimos/lucro-total-recebido-mes", autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(`
      SELECT 
        SUM(( (e.valorpagar - e.valoremprestado) / e.parcelas )) AS totalLucroARecebidoMes
      FROM emprestimos e
      JOIN parcelas p ON p.id_emprestimo = e.id
      WHERE p.status = 'Pago'
        AND MONTH(p.data_pagamento) = MONTH(CURDATE())
        AND YEAR(p.data_pagamento) = YEAR(CURDATE())
    `);

    res.json({ totalLucroARecebidoMes: result[0].totalLucroARecebidoMes || 0 });
  } catch (err) {
    console.error("Erro ao calcular lucro total recebido do mês:", err);
    res.status(500).json({ error: "Erro ao calcular lucro total recebido do mês" });
  }
});


app.patch("/parcelas/atualizar-atrasadas", autenticar, async (req, res) => {
  try {
    const hoje = new Date().toISOString().split("T")[0];

    const [parcelasAtualizadas] = await pool.query(
      `UPDATE parcelas 
       SET status = 'Atrasada' 
       WHERE status = 'Pendente' AND data_vencimento < ?`,
      [hoje]
    );

    await pool.query(
      `UPDATE emprestimos e
       JOIN parcelas p ON e.id = p.id_emprestimo
       SET e.statos = 'Em Atraso'
       WHERE p.status = 'Atrasada'`
    );

    res.json({ message: "Parcelas atrasadas atualizadas com sucesso." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar parcelas atrasadas." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
