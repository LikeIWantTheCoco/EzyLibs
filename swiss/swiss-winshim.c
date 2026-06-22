/* Swiss windows shim — POSIX bits the Ezy runtime uses that mingw's msvcrt CRT
   lacks. Compiled into the windows desktop target only. */
#ifdef _WIN32
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>

ssize_t getline(char **lineptr, size_t *n, FILE *stream) {
  if (!lineptr || !n || !stream) return -1;
  size_t pos = 0;
  int c;
  if (*lineptr == NULL || *n == 0) {
    *n = 128;
    *lineptr = (char *)malloc(*n);
    if (!*lineptr) return -1;
  }
  while ((c = fgetc(stream)) != EOF) {
    if (pos + 1 >= *n) {
      size_t nn = *n * 2;
      char *p = (char *)realloc(*lineptr, nn);
      if (!p) return -1;
      *lineptr = p;
      *n = nn;
    }
    (*lineptr)[pos++] = (char)c;
    if (c == '\n') break;
  }
  if (pos == 0 && c == EOF) return -1;
  (*lineptr)[pos] = '\0';
  return (ssize_t)pos;
}
#endif
