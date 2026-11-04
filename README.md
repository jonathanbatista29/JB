# JB IHM — IHM / SCADA Web

Software de IHM (Interface Homem-Máquina) que roda no navegador. Permite **criar telas** arrastando
botões, sinaleiros, displays, gráficos etc., **conectar com PLCs** e usar tudo em **modo operador**
em PC, tablet ou celular.

## Funcionalidades

- **Editor de telas** (arrastar e soltar): mover, redimensionar, grade, zoom, copiar/colar, desfazer, várias telas.
- **Objetos de tela**: texto, painel, botão (pulso, liga/desliga, set, reset, valor fixo, navegação), chave,
  entrada numérica com teclado na tela, controle deslizante, sinaleiro, valor numérico com limites,
  texto por estado, barra gráfica, tanque, manômetro (gauge), motor/bomba/válvula/ventilador, gráfico de tendência.
- **PLCs suportados**
  - Siemens **S7-1200, S7-1500, S7-300, S7-400** (protocolo S7, porta 102)
  - **Modbus TCP**: Siemens LOGO! 8, Schneider M221/M241, WEG, Delta, Allen-Bradley Micro800, Mitsubishi FX5U, Altus Nexto, genérico
  - **Modbus RTU** (RS-485 serial)
  - **Simulador** para testar sem PLC
- **Tags** (variáveis): BOOL, INT, WORD, DINT, DWORD, REAL, STRING, com valor ao vivo e escrita de teste.
- **Alarmes**: condições por tag, prioridade, faixa de alarme no rodapé, reconhecimento e histórico.
- Leitura otimizada (agrupa endereços Modbus em blocos), reconexão automática.
- Exportar/importar projeto em JSON.

## Como rodar

Requisito: [Node.js](https://nodejs.org) 18 ou superior.

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Para acessar de outro PC/tablet da rede, use `http://IP-DO-COMPUTADOR:3000`.
O projeto de demonstração usa o simulador, então já funciona sem PLC.

Variáveis de ambiente opcionais: `PORT` (padrão 3000), `HOST` (padrão 0.0.0.0), `DATA_DIR` (onde salvar o projeto).

## Passo a passo

1. **PLCs** → "+ Novo PLC", escolha o modelo, preencha o IP.
2. **Tags** → "+ Novo tag", escolha a conexão, o endereço e o tipo.
3. **Editor de Telas** → arraste objetos para a tela e escolha o tag de cada um no painel da direita.
4. Clique em **Salvar** (Ctrl+S). A comunicação reinicia com a nova configuração.
5. **Operação** → tela do operador.

## Endereços

| Driver | Exemplos |
|---|---|
| Siemens S7 | `DB1,X0.0` `DB1,INT2` `DB1,DINT4` `DB1,REAL8` `M0.0` `MW10` `MD20` `MR30` `I0.0` `Q0.1` `IW64` |
| Modbus (base 0) | `C0` coil · `DI0` entrada · `HR0` holding · `IR0` input · `HR0.3` bit 3 · também `40001`, `00001` |
| Simulador | `sine:amp:periodo:offset` `ramp:max:periodo` `random:min:max` `square:periodo` ou qualquer nome (memória) |

**Siemens S7-1200/1500**: no TIA Portal habilite *Permit access with PUT/GET* e desmarque
*Optimized block access* nos DBs que a IHM vai ler.

## Estrutura

```
server/            servidor Node.js
  index.js         HTTP + WebSocket
  tagManager.js    leitura cíclica, escrita e alarmes
  drivers/         simulator, modbus (TCP/RTU), s7
  models.js        modelos de PLC pré-configurados
public/            interface web (sem build)
  js/editor.js     editor de telas
  js/runtime.js    modo operação
  js/widgets.js    objetos de tela
  js/pages.js      Tags, PLCs e Alarmes
data/project.json  projeto salvo (criado ao salvar)
```

## Próximos passos sugeridos

- Login com níveis de acesso (operador / manutenção / engenharia)
- Histórico de tendências em banco de dados
- Drivers Omron FINS, Allen-Bradley EtherNet/IP, OPC UA
- Receitas e relatórios
