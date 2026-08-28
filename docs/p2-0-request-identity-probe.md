# P2-0 Request Identity Probe

## 鐩殑

P2-0 鍙敤浜庤瀵?ChatGPT Web 閫氳繃 OpenAI Secure MCP Tunnel 璋冪敤 ChatGPT-DSH 鏃剁殑璇锋眰韬唤涓?MCP Session 琛屼负锛屼笉鏀瑰彉鐜版湁 MCP / DSH Session 璇箟銆?
鏍稿績闂锛欳hatGPT 鐨勫娆?Tool Call 鏄惁澶嶇敤鍚屼竴涓?MCP Session锛涘鏋滀笉澶嶇敤锛屾槸鍚﹀瓨鍦ㄨ法 Tool Call銆佽法娑堟伅绋冲畾涓旇兘鍖哄垎 ChatGPT Conversation 鐨勮姹傝韩浠姐€?
## 鐪熸満閾捐矾

```text
ChatGPT Web
鈫?ChatGPT-DSH Connector
鈫?OpenAI Secure MCP Tunnel
鈫?tunnel-client
鈫?http://127.0.0.1:3210/mcp
鈫?ChatGPT-DSH
鈫?DSH Tool Runtime
```

P1-B 宸茬湡鏈洪獙璇侊細`tools/list`銆乣read`銆乣write` 鍧囧彲浠?ChatGPT Web 鍒拌揪鏈湴 DSH Runtime銆?
## 宸插彂鐜伴棶棰?
DSH `edit` 渚濊禆鍚屼竴 DSH Session 涓殑 read observation銆?
鐪熸満涓嵆浣垮厛 `read` 鍐?`edit`锛宍edit` 浠嶅彲鑳藉緱鍒帮細

```text
edit requires reading ... first
```

鍘熷洜涓嶆槸 Tool 鏈韩澶辨晥锛岃€屾槸 ChatGPT 鐨勪笉鍚?Tool Call 涓嶄繚璇佸鐢ㄥ悓涓€涓?MCP Session锛汸1-A 褰撳墠鍙堟槸涓€ MCP Session 瀵瑰簲涓€涓复鏃?DSH ExecutionScope锛屽洜姝?observation 鏃犳硶璺?MCP Session 寤剁画銆?
## P2-0 璇婃柇瀹炵幇

閫氳繃锛?
```text
CHATGPT_DSH_DIAGNOSTIC_REQUESTS=1
```

寮€鍚彧璇昏瘖鏂棩蹇椼€?
璇婃柇榛樿鍏抽棴锛涘紑鍚悗璁板綍璇锋眰涓?MCP / ExecutionScope 鐢熷懡鍛ㄦ湡淇℃伅锛屽苟瀵硅璇佺被 header 鍋氫弗鏍艰劚鏁忋€傝瘖鏂笉鎻愬墠娑堣垂宸插缓绔?MCP Session 鐨?request body锛屼篃涓嶆敼鍙?session routing / lifecycle銆?
## 鐪熸満娴嬭瘯

### Test A锛氬悓涓€鏉?ChatGPT 鍥炲鍐呰繛缁袱娆?read

缁撴灉锛?
```text
read #1 鈫?MCP Session A 鈫?exec-1
read #2 鈫?MCP Session B 鈫?exec-2
```

缁撹锛氬悓涓€鏉?ChatGPT 鍥炲涓殑澶氫釜 Tool Call 涔熶笉淇濊瘉澶嶇敤鍚屼竴涓?MCP Session銆?
瑙傚療鍒帮細

- `Mcp-Session-Id`锛氬彉鍖栵紱浠呬唬琛?MCP transport session銆?- ExecutionScope diagnostic id锛氬彉鍖栵紱涓庡綋鍓嶄复鏃?DSH Session 涓€涓€瀵瑰簲銆?- `x-openai-pod-uid`锛氬彉鍖栵紱灞炰簬鍩虹璁炬柦瀹炰緥淇℃伅锛屼笉閫傚悎浣滀负浼氳瘽韬唤銆?- `traceparent`锛氬悓涓€ assistant turn 鍐?trace-id 绋冲畾锛屼絾 span-id 鍙樺寲銆?- `x-request-id`锛氬悓涓€ assistant turn 鍐呬富 ID 绋冲畾锛屼絾璇锋眰鍚庣紑鍙樺寲銆?- `x-openai-session`锛氫袱娆?Tool Call 瀹屽叏绋冲畾銆?- `x-openai-subject`锛氫袱娆?Tool Call 瀹屽叏绋冲畾銆?
### Test B锛氬悓涓€ ChatGPT Conversation 鐨勪笅涓€鏉℃秷鎭?
缁撴灉锛?
- 鏂版秷鎭垱寤轰簡鏂扮殑 MCP Session 涓庢柊鐨?ExecutionScope銆?- `traceparent` 鐨?trace-id 鍙戠敓鍙樺寲銆?- `x-request-id` 涓?ID 鍙戠敓鍙樺寲銆?- `x-openai-session` 淇濇寔涓嶅彉銆?- `x-openai-subject` 淇濇寔涓嶅彉銆?
缁撹锛歚x-openai-session` 鐨勭ǔ瀹氳寖鍥撮珮浜庡崟娆?assistant turn锛岃嚦灏戣兘璺ㄥ悓涓€ ChatGPT Conversation 鐨勫鏉℃秷鎭繚鎸佺ǔ瀹氥€?
### Test C锛氭柊寤?ChatGPT Conversation

缁撴灉锛?
- `x-openai-session` 鍙戠敓鍙樺寲銆?- `x-openai-subject` 淇濇寔涓嶅彉銆?
缁撹锛氬湪褰撳墠 ChatGPT Web + Secure MCP Tunnel 鐪熸満閾捐矾涓細

```text
x-openai-session 鈫?琛ㄧ幇涓?Conversation / session scoped identity
x-openai-subject 鈫?琛ㄧ幇涓?subject / account scoped identity
```

## P2-0 缁撹

P2-0 璋冩煡鐩爣瀹屾垚銆?
褰撳墠鍙互纭锛?
1. `Mcp-Session-Id` 涓嶈兘浣滀负 ChatGPT Conversation 鐨勯暱鏈熺姸鎬侀敭銆?2. DSH observation / cwd / 鍚庣画鐘舵€佷笉搴旇缁戝畾 MCP transport session銆?3. `x-openai-session` 鏄綋鍓嶆渶寮虹殑 Conversation scoped Bridge Identity 鍊欓€夈€?4. `x-openai-subject` 鍙綔涓烘洿涓婂眰 subject namespace锛屼笌 `x-openai-session` 缁勫悎鐢ㄤ簬闅旂涓嶅悓鐢ㄦ埛涓庝笉鍚?Conversation銆?5. 杩欎袱涓?header 鏄綋鍓嶇湡鏈鸿瀵熷埌鐨?OpenAI 璇锋眰瀛楁锛屼笉灞炰簬 MCP 鏍囧噯锛屼篃涓嶅簲琚涓烘案涔呭叕寮€濂戠害銆?
## P2-A 璁捐鏂瑰悜

涓嬩竴闃舵搴斿紩鍏ョ嫭绔嬬殑 identity resolver 涓?Bridge Session 灞傦紝鑰屼笉鏄湪鏍稿績閫昏緫涓洿鎺ョ‖缂栫爜 OpenAI header锛?
```text
HTTP Request
鈫?RequestIdentityResolver
鈫?BridgeIdentity
鈫?BridgeSessionStore
鈫?Stable DSH ExecutionScope
```

OpenAI 璺緞鍙敱 adapter 鏍规嵁锛?
```text
x-openai-subject + x-openai-session
```

瑙ｆ瀽鍑?opaque Bridge Identity锛涙牳蹇?Bridge Session 灞備笉渚濊禆鍏蜂綋 header 鍚嶇О銆?
鍚屾椂淇濈暀 generic MCP fallback锛氬鏋滆姹備腑娌℃湁鍙敤鐨勭ǔ瀹?Bridge Identity锛屽垯缁х画浣跨敤 P1-A 鐨勨€滀竴 MCP Session 鈫?涓€涓存椂 DSH Session鈥濊涓猴紝閬垮厤 ChatGPT-DSH 琚粦瀹氫负鍙敮鎸?OpenAI Secure MCP Tunnel銆?
## 闃舵鐘舵€?
```text
P0     Closed
P1-A   Closed
P1-B   Closed 鈥?Remote MCP exposure + ChatGPT Web real-device validation
P2-0   Closed 鈥?Request Identity Probe
P2-A   Next 鈥?Stable Bridge Session
```
