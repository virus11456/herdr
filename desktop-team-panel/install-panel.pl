use strict;
use warnings;
use File::Basename qw(dirname);
use File::Path qw(make_path);
use File::Copy qw(copy);
use Cwd qw(abs_path);
use JSON::PP;
my $bundle = dirname(abs_path(__FILE__));
my $h = $ENV{HOME};
my $app = "$h/.config/herdr-app";
my $cli = "$h/.local/bin/herdr-app";
my $stamp = time;
my ($folder, $terminal, $space) = @ARGV;
die "Folder is not a directory\n" if defined($folder) && !-d $folder;
system($^X, "$bundle/configure-herdr.pl") == 0 or die "Agent configuration failed\n";
sub save {
    my ($file, $text) = @_;
    if (-e $file) {
        open my $in, '<', $file or die $!; local $/; my $old = <$in>; close $in;
        return if $old eq $text;
        copy($file, "$file.backup-$stamp") or die $!;
    }
    open my $out, '>', "$file.tmp-$$" or die $!; print {$out} $text; close $out or die $!;
    rename("$file.tmp-$$", $file) or die $!;
}
make_path("$app/mods/team-chat");
for my $file ('main.js', 'mod.json') {
    open my $in, '<', "$bundle/mods/team-chat/$file" or die $!; local $/; my $text = <$in>; close $in;
    save("$app/mods/team-chat/$file", $text);
}
system($cli, 'check', "$app/mods/team-chat") == 0 or die "Panel check failed; do not activate it\n";
my $layout_file = "$app/layouts/team-work.json";
if (!-e $layout_file) { system($cli, 'do', 'layout.clone', '{"name":"main","as":"team-work"}') == 0 or die "Cannot clone layout\n"; }
open my $in, '<', $layout_file or die $!; local $/; my $layout = decode_json(<$in>); close $in;
sub find_node {
    my ($node, $id) = @_;
    return $node if ($node->{id} || '') eq $id;
    for my $child (@{$node->{children} || []}) { my $got = find_node($child, $id); return $got if $got; }
    return;
}
$layout->{type} = 'column';
$layout->{children} = [
    {id => 'chat-titlebar', type => 'block', size => {px => 46}, window_drag => JSON::PP::true, content => {mod => 'workspace-chrome'}},
    {id => 'chat-surface', type => 'block', size => {weight => 1}, content => {mod => 'team-chat'}},
];
save($layout_file, JSON::PP->new->utf8->pretty->canonical->encode($layout));
if ($folder) {
    my $initial = {folder => abs_path($folder), requestId => "$stamp-$$"};
    $initial->{terminal} = $terminal if $terminal;
    $initial->{space} = $space if $space;
    save("$app/team-chat.json", JSON::PP->new->utf8->pretty->encode($initial));
}
system($cli, 'do', 'layout.switch', '{"name":"team-work"}') == 0 or die "Cannot show layout\n";
print "Chat view installed in the custom team-work layout.\n";
