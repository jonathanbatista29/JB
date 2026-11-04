# JB IHM — IHM / SCADA Web

Software de IHM (Interface Homem-Máquina) que roda no navegador. Permite **criar telas** arrastando
botões, sinaleiros, displays, gráficos etc., **conectar com PLCs** e usar tudo em **modo operador**
em PC, tablet ou celular.

## Funcionalidades

- **Editor de telas** (arrastar e soltar): mover, redimensionar, grade, zoom, copiar/colar, desfazer, várias telas.
  Alças nos 4 cantos e no meio de cada lado redimensionam; segure **Shift** para manter a proporção.
  Duplo clique num botão, texto ou sinaleiro edita o texto direto na tela (Enter confirma, Shift+Enter nova linha,
  Esc cancela). Textos de botões podem ter várias linhas.
- **Objetos de tela**: texto, painel, botão (pulso, liga/desliga, set, reset, valor fixo, navegação), chave,
  entrada numérica com teclado na tela, controle deslizante, sinaleiro, valor numérico com limites,
  texto por estado, barra gráfica, tanque, manômetro (gauge), motor/bomba/válvula/ventilador, gráfico de tendência.
- **PLCs suportados**
  - Siemens **S7-1200, S7-1500, S7-300, S7-400** (protocolo S7, porta 102)
  - Allen-Bradley **CompactLogix / ControlLogix** (EtherNet/IP, acesso direto pelo nome do tag)
  - **Modbus TCP**: Siemens LOGO! 8, Schneider M221/M241, WEG, Delta, Allen-Bradley Micro800, Mitsubishi FX5U, Altus Nexto, genérico
  - **Modbus RTU** (RS-485 serial)
  - **Multímetro Rigol DM858 / DM858E** e outros instrumentos **SCPI por rede (TCP)**
  - **Simulador** para testar sem PLC
- **Tags** (variáveis): BOOL, INT, WORD, DINT, DWORD, REAL, STRING, com valor ao vivo e escrita de teste.
- **Alarmes**: condições por tag, prioridade, faixa de alarme no rodapé, reconhecimento e histórico.
- **Login com níveis de acesso** (Operador, Manutenção, Engenharia, Administrador), logout automático por
  inatividade, nível mínimo por objeto de tela e por tag, e registro de ações (quem fez o quê e quando).
- **Histórico em banco de dados (SQLite)**: valores dos tags, eventos de alarme e registro de ações,
  com gráfico por período, zoom, resumo (mín./média/máx.) e exportação CSV.
- **Gateway**: copia valores entre equipamentos diferentes (ex.: multímetro ➜ PLC e PLC ➜ multímetro).
- Leitura otimizada (agrupa endereços Modbus em blocos), reconexão automática.
- Exportar/importar projeto em JSON.

## Como rodar

Requisito: [Node.js](https://nodejs.org) 22.13 ou superior (o banco SQLite já vem embutido no Node).

**Windows:** dê dois cliques em **`iniciar_ihm.bat`**. Ele confere o Node.js, instala as dependências
na primeira vez (ou depois de atualizar o programa), inicia o servidor, mostra os endereços da rede e abre o
navegador. Para parar, feche a janela. Para trocar a porta, edite a linha `set PORT=3000` do arquivo.

**Outros sistemas (ou pelo terminal):**

```bash
npm install
npm start
```

Abra `http://localhost:3000`: aparece a **lista de projetos**. Cada projeto abre no próprio endereço,
por exemplo `http://IP-DO-COMPUTADOR:3000/estacao-1/`. Na primeira vez é criado o projeto "Estação 1",
com o exemplo do simulador, então já funciona sem PLC.

Variáveis de ambiente opcionais: `PORT` (padrão 3000), `HOST` (padrão 0.0.0.0), `DATA_DIR` (onde salvar o projeto).

## Passo a passo

1. **PLCs** → "+ Novo PLC", escolha o modelo, preencha o IP.
2. **Tags** → "+ Novo tag", escolha a conexão, o endereço e o tipo.
3. **Editor de Telas** → arraste objetos para a tela e escolha o tag de cada um no painel da direita.
4. Clique em **Salvar** (Ctrl+S). A comunicação reinicia com a nova configuração.
5. **Operação** → tela do operador.

## Vários projetos (uma IHM por estação) e backup

O mesmo servidor roda **vários projetos ao mesmo tempo**, cada um com as próprias telas, tags, PLCs
(drivers e IPs), gateway, alarmes e histórico. Cada projeto tem um endereço tirado do nome:

| Projeto | Endereço |
|---|---|
| Estação 1 | `http://IP:3000/estacao-1/` |
| Estação 2 | `http://IP:3000/estacao-2/` |

Na lista de projetos (`http://IP:3000/`):
- **+ Novo projeto**: vazio ou a partir do exemplo. **Duplicar** copia um projeto pronto (confira os IPs dos PLCs da cópia).
- **Renomear** muda o nome (o endereço continua o mesmo). **Excluir** move a pasta para `data/lixeira` (dá para recuperar).
- **⬇ Backup do projeto**: baixa a configuração completa (`.json`). **⬇ Histórico (.db)**: baixa o banco de histórico.
- **🕘 Versões salvas**: a cada "Salvar", a versão anterior é guardada automaticamente (as últimas 30) e pode ser restaurada.
- **Importar projeto**: cria um projeto novo a partir de um backup.
- **⬆ Restaurar backup aqui**: abre um backup por cima de um projeto existente (no modo edição). A configuração
  atual fica em "Versões salvas", então dá para desfazer.
- **⬇ Backup geral / Restaurar backup geral** (administrador): todos os projetos num arquivo só.

### Modo edição e modo produção

Cada projeto tem um modo, mostrado no topo (✎ EDIÇÃO / ● PRODUÇÃO):

- **▶ Produção** (Engenharia): abre um alerta para confirmar e escolher a **tela inicial**. Ao confirmar,
  alterações pendentes são salvas, a edição de telas, tags, PLCs, gateway e alarmes fica **travada para todos**
  (o servidor também recusa salvar) e todos os painéis abertos vão para a tela inicial.
  Em produção, um painel aberto sempre começa na tela inicial.
- **✎ Editar**: volta para o modo edição. A operação e a comunicação com os PLCs continuam; os painéis
  mostram o selo "EDIÇÃO".
- A tela inicial também pode ser marcada no Editor (propriedades da tela → "★ Tela inicial").
- O modo pode ser trocado na lista de projetos e fica registrado no registro de ações.

Usuários e níveis de acesso valem para todos os projetos (um login só). O registro de ações mostra em qual
projeto cada ação aconteceu. Uma instalação antiga (um projeto só) é convertida sozinha na primeira vez.

## Login e níveis de acesso

No primeiro uso entre com **usuário `admin` e senha `admin`**. O sistema obriga a trocar a senha.

| Nível | Pode |
|---|---|
| Sem login | Conforme configuração: bloqueado, só visualizar (padrão) ou operar |
| Operador | Usar os comandos das telas e reconhecer alarmes |
| Manutenção | + ver Tags e PLCs (só leitura) e escrever valores de teste |
| Engenharia | + editar telas, tags, PLCs, alarmes e salvar o projeto |
| Administrador | + gerenciar usuários, configurações de acesso e ver o registro de ações |

- As permissões são verificadas no servidor, não só na tela.
- Cada tag tem um "nível mínimo para escrever"; cada botão/chave/entrada pode exigir um nível maior.
- Objetos bloqueados aparecem com 🔒; ao tocar, a IHM pede login.
- Usuários ficam em `data/users.json` e o registro de ações no banco `data/sistema.db` (fora dos projetos exportados).
- Esqueceu a senha do admin? Pare o servidor e apague `data/users.json`: o usuário `admin`/`admin` é recriado
  (os outros usuários serão perdidos).

## Imagens nas telas

- **Objeto Imagem** (paleta → Básico): escolha a imagem no painel da direita ou clique em "⬆ Enviar imagem".
- **Arrastar arquivo**: solte um arquivo de imagem do computador direto na tela do editor; ele é enviado e
  vira um objeto Imagem do tamanho certo.
- **Imagem que muda com o tag**: escolha um tag e a "imagem quando o tag ligar" (ex.: máquina parada/ligada).
- **Imagem de fundo da tela**: nas propriedades da tela (sem objeto selecionado), com ajuste preencher, caber ou esticar.
- **Biblioteca**: botão "Biblioteca" mostra as imagens do projeto; dá para reaproveitar e excluir as que não estão em uso.
- Formatos PNG, JPG, GIF, WEBP e SVG, até 5 MB. Ficam em `data/projects/<endereço>/imagens/` e vão junto nos backups.

## Troca de tela

Uma tela pode ser aberta de quatro jeitos:

1. **Botão de tela (biblioteca)**: cada botão de tela tem um número sequencial (1, 2, 3...) e abre uma tela.
   Ele pode ser colocado em várias telas, e mudar o texto, cor ou destino muda todas as cópias.
   - Crie a tela (ex.: "Configuração") e, nas propriedades dela, em "Botão de chamada desta tela",
     escolha "+ Criar botão para esta tela".
   - Arraste o botão da paleta ("Botões de tela") para as telas onde ele deve aparecer.
   - Na operação, o botão da tela que está aberta fica destacado (bom para menus).
1. **Botão comum**: ação "Ir para outra tela" ou "Voltar à tela anterior".
2. **Bit do PLC (BOOL)**: no Editor, sem nenhum objeto selecionado, escolha em "Abrir quando este BOOL ligar".
   A tela abre quando o bit liga. Marque "Desligar o bit depois de abrir" para a IHM zerar o bit sozinha.
3. **Número pelo PLC (INT/DINT)**: cada tela tem um "Número da tela". Escolha o "Tag com o nº da tela a abrir":
   quando o PLC escreve 2, todos os painéis abrem a tela nº 2. Opções: zerar o tag depois de trocar e
   escrever o número da tela aberta em outro tag ("tela atual"), para o PLC saber onde o operador está.

O projeto de demonstração já vem configurado com os tags `Tela_Solicitada`, `Tela_Atual` e `Abrir_Tendencias`.

## Multímetro (SCPI) e Gateway

**Ligar o multímetro Rigol DM858/DM858E:**
1. No multímetro, configure a rede (Utility → IO) e anote o IP.
2. Na aba PLCs, "+ Novo PLC", modelo **Multímetro DM858 / DM858E (SCPI por LAN)**, informe o IP.
   Porta de socket SCPI: **5025** (conforme o *DM858 Series Programming Guide*).
3. Clique em **"+ Criar tags do multímetro"** e em Salvar.

O tag de função usa o número: 1 = tensão DC, 2 = tensão AC, 3 = corrente DC, 4 = corrente AC,
5 = resistência (2 fios), 6 = frequência, 7 = capacitância, 8 = resistência 4 fios, 9 = período,
10 = continuidade, 11 = diodo, 12 = temperatura. O PLC escreve o número para trocar a função
(comando `CONF:...`) e lê o número da função atual (consulta `FUNC?`, que o DM858 responde em forma
curta, ex.: `"VOLT"` para tensão DC).

**Endereços SCPI** (o endereço do tag é o próprio comando):

| Endereço | O que faz |
|---|---|
| `READ?` | Lê a medida atual (REAL) |
| `MEAS:VOLT:DC?` | Configura e mede (mais lento) |
| `*IDN?` | Identificação (STRING) |
| `FUNC? \| CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC}` | Função por número: o PLC escreve 1, 2, 3... |
| `\| *RST` | Só comando (BOOL): envia `*RST` quando liga |
| `consulta? \| comando {v}` | Lê com a consulta e escreve trocando `{v}` pelo valor |

Valores de sobrecarga (OL, 9,9E37) aparecem como qualidade ruim.

**Gateway** (aba 🔀 Gateway): cada ligação copia o valor de um tag de origem para um tag de destino.
- Multímetro ➜ PLC: `DMM_Medida` ➜ REAL no PLC (ou INT com ganho 1000 para mV).
- PLC ➜ multímetro: INT do PLC com o número da função ➜ `DMM_Funcao`.
- Comando ao ligar (pulso): bit do PLC ➜ `DMM_Reset`, com opção de desligar o bit depois.
- Status da conexão: manda 1/0 para o PLC saber se o multímetro está online.
- Quando um equipamento reconecta, o último valor é reenviado.
- **Só quando**: a ligação copia apenas quando outro tag tem um valor. Assim cada função do multímetro
  vai para uma memória própria do PLC (ex.: medida ➜ `PLC_VDC` só quando a função = 1, ➜ `PLC_VAC` quando = 2).
  O botão **"+ Medida por função"** cria essas ligações para todas as funções de uma vez; a memória de cada
  função guarda o último valor enquanto o multímetro mede outra coisa.

O manual de programação do DM858 está em [`docs/DM858_ProgrammingGuide_EN.pdf`](docs/DM858_ProgrammingGuide_EN.pdf).

## Histórico

O histórico de cada projeto fica em `data/projects/<endereço>/historico.db` (SQLite), que pode ser aberto com qualquer ferramenta SQLite
(ex.: DB Browser for SQLite).

- **O que registrar**: na aba Tags, marque a coluna "Histórico". A "banda morta" é a variação mínima para gravar
  (ex.: 0,1 °C), o que economiza espaço.
- **Quando grava**: sempre que o valor muda além da banda morta e, no mínimo, a cada 60 s (configurável).
- **Por quanto tempo**: 90 dias por padrão (Histórico → Configuração). O registro de ações é guardado por no mínimo 1 ano.
- **Consulta**: aba 📊 Histórico — escolha os tags e o período, arraste no gráfico para ampliar e exporte em CSV
  (abre direto no Excel). A aba Alarmes mostra todos os eventos com filtro e exportação.
- O gráfico de tendência das telas já abre com os dados do banco.

## Endereços

| Driver | Exemplos |
|---|---|
| Siemens S7 | `DB1,X0.0` `DB1,INT2` `DB1,DINT4` `DB1,REAL8` `M0.0` `MW10` `MD20` `MR30` `I0.0` `Q0.1` `IW64` |
| CompactLogix / ControlLogix | `Motor_Run` `Program:MainProgram.Nivel` `Receita[3]` `Maquina.Velocidade` `Status.5` (bit de DINT) |
| Modbus (base 0) | `C0` coil · `DI0` entrada · `HR0` holding · `IR0` input · `HR0.3` bit 3 · também `40001`, `00001` |
| Simulador | `sine:amp:periodo:offset` `ramp:max:periodo` `random:min:max` `square:periodo` ou qualquer nome (memória) |

**Siemens S7-1200/1500**: no TIA Portal habilite *Permit access with PUT/GET* e desmarque
*Optimized block access* nos DBs que a IHM vai ler.

**CompactLogix**: informe o IP e slot 0. Os tags são lidos pelo nome, sem mapeamento. A opção
"Ler lista de tags ao conectar" é necessária para UDTs e STRING.

## Estrutura

```
server/            servidor Node.js
  index.js         HTTP + WebSocket (lista de projetos e um endereço por projeto)
  projects.js      projetos rodando ao mesmo tempo, criação, exclusão
  auth.js          usuários, sessões e registro de ações
  historian.js     histórico em banco SQLite
  navigator.js     troca de tela pelo PLC
  gateway.js       cópia de valores entre equipamentos
  images.js        imagens das telas
  tagManager.js    leitura cíclica, escrita e alarmes
  drivers/         simulator, modbus (TCP/RTU), s7, logix (CompactLogix), scpi (multímetro)
  models.js        modelos de PLC pré-configurados
public/            interface web (sem build)
  js/editor.js     editor de telas
  js/runtime.js    modo operação
  js/widgets.js    objetos de tela
  js/pages.js      Tags, PLCs e Alarmes
  projects.html    lista de projetos (js/projects.js)
data/
  projects/<endereço>/  project.json, backups/ (versões), imagens/, historico.db, estado.json (modo)
  users.json            usuários
  sistema.db            registro de ações
  lixeira/              projetos excluídos
```

## Próximos passos sugeridos

- Drivers Omron FINS, OPC UA
- Receitas e relatórios
