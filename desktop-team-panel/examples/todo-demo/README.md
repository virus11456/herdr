> 這是多代理協作驗收的原始範例，不是生產級多寫入者工具。並行寫入及其他已知限制見 REVIEW.md、RESULT.md。來源本機路徑已遮去；完整驗證範圍以部署包 VALIDATION.md 為準。

# 待辦清單 CLI

零外部依賴，使用本機指定的 Node.js runtime。從此資料夾執行：

```sh
~/.minimax-code/runtime/node/bin/node todo.mjs add '買牛奶 🥛'
~/.minimax-code/runtime/node/bin/node todo.mjs list
~/.minimax-code/runtime/node/bin/node todo.mjs done 1
```

`add` 與 `done` 各輸出一個 JSON 物件，例如 `{"id":1,"text":"買牛奶 🥛","done":false}`；`list` 輸出全部待辦的 JSON 陣列，包含已完成項目。重複完成同一項目仍成功。

預設讀寫**執行時目前資料夾**的 `tasks.json`。可用 `--file` 指定其他檔案，父資料夾必須已存在：

```sh
~/.minimax-code/runtime/node/bin/node todo.mjs --file './我的待辦.json' add '閱讀 日本語 / English'
~/.minimax-code/runtime/node/bin/node todo.mjs --file './我的待辦.json' list
~/.minimax-code/runtime/node/bin/node todo.mjs --file './我的待辦.json' done 1
```

`--file` 也可放在命令後，但只能指定一次。含空格的路徑或文字請加引號；多個文字參數會以單一空格串接。需要以 `-` 開頭或包含字面上的 `--file` 時，使用 `--` 結束選項解析，例如：

```sh
~/.minimax-code/runtime/node/bin/node todo.mjs add -- '--file 是這項待辦的文字'
```

檔案不存在時視為空清單；`list` 不會建立檔案，首次成功 `add` 才會建立。ID 為遞增正整數，完成項目後不會重用。空白文字、未知 ID、未知命令、錯誤選項、無效 JSON 或不符資料格式的檔案都會在 stderr 說明原因，以退出碼 `1` 結束，保留既有資料。成功退出碼為 `0`，stdout 僅包含結果 JSON。

檔案格式為 `{"version":1,"nextId":2,"tasks":[{"id":1,"text":"買牛奶 🥛","done":false}]}`。請保留 `nextId`，且避免同時執行多個寫入命令；此 CLI 不提供跨程序鎖定。

執行驗證：

```sh
~/.minimax-code/runtime/node/bin/node --check todo.mjs
~/.minimax-code/runtime/node/bin/node test.mjs
```

測試會在此專案內建立暫存測試資料夾，結束後刪除。
