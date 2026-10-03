// web-piece - the platform layer lhasa expects, for a WebAssembly module with no file system.
// Copyright (C) 2026 the web-piece authors. GPL-3.0-or-later; see LICENSE. No warranty.
// Archives are only ever read from memory into memory, so everything that would touch a disk says "no".
#include "lha_arch.h"
#include <stdio.h>
#include <stdlib.h>

int lha_arch_vasprintf(char **result, const char *fmt, va_list args) {
    va_list copy;
    va_copy(copy, args);
    const int len = vsnprintf(NULL, 0, fmt, copy);
    va_end(copy);
    if (len < 0) { *result = NULL; return -1; }
    *result = malloc((size_t)len + 1);
    if (!*result) return -1;
    return vsnprintf(*result, (size_t)len + 1, fmt, args);
}
void lha_arch_set_binary(FILE *handle) { (void)handle; }
int lha_arch_mkdir(char *path, unsigned int unix_perms) { (void)path; (void)unix_perms; return 0; }
int lha_arch_chown(char *filename, int unix_uid, int unix_gid) { (void)filename; (void)unix_uid; (void)unix_gid; return 0; }
int lha_arch_chmod(char *filename, int unix_perms) { (void)filename; (void)unix_perms; return 0; }
int lha_arch_utime(char *filename, unsigned int timestamp) { (void)filename; (void)timestamp; return 0; }
int lha_arch_set_windows_timestamps(char *filename, uint64_t creation_time, uint64_t modification_time, uint64_t access_time) {
    (void)filename; (void)creation_time; (void)modification_time; (void)access_time; return 0;
}
FILE *lha_arch_fopen(char *filename, int unix_uid, int unix_gid, int unix_perms) { (void)filename; (void)unix_uid; (void)unix_gid; (void)unix_perms; return NULL; }
LHAFileType lha_arch_exists(char *filename) { (void)filename; return LHA_FILE_NONE; }
int lha_arch_symlink(char *path, char *target) { (void)path; (void)target; return 0; }
