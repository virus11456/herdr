use strict;
use warnings;
use JSON::PP;
use File::Path qw(make_path);
use File::Copy qw(copy);
use Cwd qw(abs_path);
use File::Basename qw(dirname);

my $h = $ENV{HOME};
my $stamp = time;
my $bin = "$h/.local/bin";
my $app = "$h/.config/herdr-app";
my $templates = "$h/.config/herdr-core/templates";
my $bundle = dirname(abs_path(__FILE__));
die "Open Herdr once before configuring it\n" unless -f "$app/AGENTS.md";
make_path($bin, $templates);

sub save {
    my ($path, $text, $mode) = @_;
    if (-e $path) {
        open my $old, '<', $path or die "$path: $!";
        local $/; my $before = <$old>; close $old;
        return if $before eq $text;
        copy($path, "$path.backup-$stamp") or die "Backup $path: $!";
    }
    open my $out, '>', "$path.tmp-$$" or die "$path: $!";
    print {$out} $text; close $out or die "$path: $!";
    chmod($mode, "$path.tmp-$$") or die "$path: $!";
    rename("$path.tmp-$$", $path) or die "$path: $!";
    print "Configured $path\n";
}

my @codex_candidates = (
    ($ENV{HERDR_CODEX_EXECUTABLE} || ()),
    (map { "$_/codex" } split /:/, ($ENV{PATH} || '')),
    "$bin/codex",
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
);
my ($codex_target) = map { abs_path($_) } grep { -x $_ && !-d $_ } @codex_candidates;
die "Install Codex CLI first, or set HERDR_CODEX_EXECUTABLE\n" unless $codex_target;
die "Install Claude Code first\n" unless -x "$bin/claude";
my %links = (codex => $codex_target);
while (my ($name, $target) = each %links) {
    die "Missing executable $target" unless -x $target;
    my $link = "$bin/$name";
    if (!-e $link && !-l $link) { symlink($target, $link) or die "$link: $!"; }
}
die "MiniMax executable missing" unless -x "$h/.minimax-code/bin/mcode";
save("$bin/mcode", "#!/bin/sh\nset -eu\nexec \"\$HOME/.minimax-code/bin/mcode\" \"\$@\"\n", 0755);

my $rc = "$h/.zshrc";
my $rc_text = '';
if (-e $rc) { open my $in, '<', $rc or die $!; local $/; $rc_text = <$in>; close $in; }
if ($rc_text !~ /(?:\$HOME|\$\{HOME\}|\Q$h\E)\/\.local\/bin/) {
    save($rc, $rc_text . "\n# Herdr and coding agent CLI tools\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\n", 0644);
}
my $register_claude = '';
my $register_codex = '';
my $hook_settings = '';
if (-f "$bundle/team-runtime.mjs") {
    my @node_candidates = (($ENV{HERDR_TEAM_NODE} || ()), (map { "$_/node" } split /:/, ($ENV{PATH} || '')), "$h/.minimax-code/runtime/node/bin/node");
    my ($node) = grep { -x $_ && !-d $_ } @node_candidates;
    die "Node.js is required for the team runtime; set HERDR_TEAM_NODE\n" unless $node;
    open my $in, '<', "$bundle/team-runtime.mjs" or die $!; local $/; my $runtime = <$in>; close $in;
    save("$app/team-runtime.mjs", $runtime, 0600);
    save("$bin/herdr-team-runtime", "#!/bin/sh\nset -eu\nexec \"$node\" \"\$HOME/.config/herdr-app/team-runtime.mjs\" \"\$@\"\n", 0755);
    open my $settings_pipe, '-|', $node, "$app/team-runtime.mjs", 'settings', "$app/team-runtime.mjs", $node or die $!;
    my $settings = <$settings_pipe>; close $settings_pipe or die "Cannot generate hook settings";
    decode_json($settings);
    save("$app/team-claude-settings.json", $settings, 0600);
    $register_claude = "\"\$HOME/.local/bin/herdr-team-runtime\" register claude\n";
    $register_codex = "\"\$HOME/.local/bin/herdr-team-runtime\" register codex\n";
    $hook_settings = " --settings \"\$HOME/.config/herdr-app/team-claude-settings.json\"";
}

my $lead_prompt = <<'PROMPT';
你是這個 Herdr 工作區的協作總控，使用繁體中文溝通。主總控是 Claude；Claude 額度耗盡或無法使用時，由 Codex 備援總控接手。
先讀取 ~/.config/herdr-app/AGENTS.md，執行 hc --skill 和 hc templates，了解現有協作工具。
如果使用者尚未提供具體任務，先詢問專案目標，等待任務；不要自行展開工作或啟動其他代理。
收到任務後，由你拆解、派工、收集結果、檢查和整合。可用角色：herdr-codex-implement（實作）、herdr-minimax-cn（測試與獨立審查）。
在專案內 .herdr-team/STATUS.md 保存目標、驗收條件、任務分工、worker 終端 ID、已完成事項、待辦與阻礙；分派任務前後與收到回報後都更新。備援接手時先讀此檔並檢查現有終端，避免重複派工。
每回合及派工前檢查 .herdr-team/control.json；如果目前總控 terminal 已不是自己的 HC_TERMINAL_ID，就停止派工並告知已交棒。同一個回報 ID 只處理一次。
Codex 備援若因沙箱無法使用 hc，不要解除沙箱。改用 herdr-team-runtime request <action> '<JSON參數>'，保存回傳的 id，再以 herdr-team-runtime response <id> 等待 Herdr 面板執行並回傳。可用 action：templates、list、run（參數 template/name/task/cwd）、get/read/wait/send/interrupt（參數 terminal；read 另有 lines；send 另有 text）。只允許目前總控、同一團隊終端與專案內的工作資料夾。request 回傳 queued 不是完成；必須讀 response，逾時先檢查同一個 id，不能盲目重派。面板必須開啟。
每次實際派工、收到回報及完成階段，執行 herdr-team-runtime log 總控 "簡短真實摘要"，讓協作面板顯示紀錄。請工作代理也用此工具記錄真實回報；不要記錄憑證、隱藏思考或虛構對話。
使用 hc run --bg --name <唯一名稱> --cwd <明確資料夾> <角色範本> <具體任務>，每個任務交代範圍、完成條件、回報對象與不得再派工。
多個代理需要同時改碼時，先在實際 Git 專案建立不同 worktree；若沒有可用 Git 或開發工具，就採用一次一個寫入者。審查代理預設唯讀。
使用 hc read/get/send 與 hc wait 收取回報。第一次啟動遇到登入、信任或權限畫面時，交由使用者處理，不能略過。MiniMax 可能沒有 OSC 狀態，不能把安靜當成完成，必須以明確回報和實際產物確認。
長回報寫入專案內指定檔案，再用 hc send <總控終端 ID> 回傳摘要與路徑。只有實際通過必要驗證才宣告完成。
不自動發布、部署、推送或付費購買；需要時依使用者對具體任務的授權行動。
PROMPT
my $lead = "#!/bin/sh\nset -eu\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\n$register_claude" . "prompt=\$(cat <<'HERDR_TEAM_PROMPT'\n$lead_prompt" . "HERDR_TEAM_PROMPT\n)\nexec \"\$HOME/.local/bin/claude\"$hook_settings --append-system-prompt \"\$prompt\" \"\$@\"\n";
save("$bin/herdr-team-lead", $lead, 0755);
my $backup = "#!/bin/sh\nset -eu\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\n$register_codex" . "prompt=\$(cat <<'HERDR_TEAM_PROMPT'\n$lead_prompt" . "HERDR_TEAM_PROMPT\n)\nexec \"\$HOME/.local/bin/codex\" --no-daemon \"\$prompt\n你目前是備援總控。若尚未有具體任務或交接紀錄，先詢問使用者；若已有交接，先確認上一位總控已停止再接手，避免兩個總控同時派工。\n接手要求：\$*\"\n";
save("$bin/herdr-team-backup", $backup, 0755);

my $file = "$app/programs.json";
my $config = {};
if (-e $file) { open my $in, '<', $file or die $!; local $/; $config = decode_json(<$in>); close $in; }
$config->{programs}->{claude}->{run} = ["$bin/claude"];
$config->{programs}->{codex}->{run} = ["$bin/codex", '--no-daemon'];
$config->{programs}->{mcode} = {
    name => 'MiniMax CN', run => ["$bin/mcode"],
    tile => '#ef4b66', color => '#ffffff', match => ['mcode'],
};
$config->{programs}->{'herdr-team-lead'} = {
    name => 'Claude - Team Lead', icon => 'icons/claude.svg',
    run => ["$bin/herdr-team-lead"], tile => '#64748b',
};
$config->{programs}->{'herdr-team-backup'} = {
    name => 'Codex - Backup Lead', icon => 'icons/codex.svg',
    run => ["$bin/herdr-team-backup"], tile => '#64748b',
};
save($file, JSON::PP->new->utf8->pretty->canonical->encode($config), 0600);

my @roles = (
    ['herdr-codex-implement', "$bin/codex --no-daemon", 'Implementation with Codex',
     "你是實作代理。只處理交付的範圍，先讀程式再修改，完成後執行適當驗證。不得再啟動其他代理。回報改動、檢查結果與阻礙；若任務包含總控終端 ID，優先使用 herdr-team-runtime report <總控ID> Codex <摘要> 回報。此工具只在專案內排入檔案訊息，由 Herdr 面板轉送，因此不需解除 Codex 沙箱來存取 hc socket。"],
    ['herdr-minimax-cn', "$bin/mcode", 'MiniMax CN independent checks and testing',
     "你是 MiniMax CN 檢查代理。預設唯讀，除非任務明確允許修改。檢查實作、邊界情況與測試；只回報可重現且有證據的問題。不得再啟動其他代理。暫存檔只寫專案內獨立測試目錄，不使用 /tmp/err.txt 等共用固定路徑。完成或受阻時，使用任務提供的總控終端 ID 以 herdr-team-runtime report <總控ID> MiniMax <摘要> 回報。", 'quiet'],
);
for my $role (@roles) {
    my ($name, $command, $description, $prompt, $ready) = @$role;
    my $text = "---\ndescription: $description\ncommand: $command\n";
    $text .= "ready: $ready\n" if $ready;
    $text .= "---\n$prompt\n";
    save("$templates/$name.md", $text, 0600);
}
for my $old_name ('herdr-claude', 'herdr-codex-review') {
    my $old_file = "$templates/$old_name.md";
    next unless -f $old_file;
    open my $in, '<', $old_file or die $!; local $/; my $old = <$in>; close $in;
    if ($old =~ /^description: (?:Implementation with Claude Code|Read-only review with Codex)$/m) {
        rename($old_file, "$old_file.disabled-$stamp") or die $!;
        print "Archived obsolete managed role $old_name\n";
    }
}
