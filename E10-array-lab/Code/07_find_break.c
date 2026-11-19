#include <stdio.h>

/* 找到就停：break 版 */
int find_break(int a[], int n, int key, int *cmp)
{
    int i;

    *cmp = 0;
    for (i = 0; i < n; i++) {
        (*cmp)++;
        if (a[i] == key) {
            return i;
        }
    }
    return -1;
}

/* 比到底：不带 break 的版本 */
int find_nobreak(int a[], int n, int key, int *cmp)
{
    int i;
    int pos = -1;

    *cmp = 0;
    for (i = 0; i < n; i++) {
        (*cmp)++;
        if (a[i] == key) {
            pos = i;
        }
    }
    return pos;
}

int main(void)
{
    int a[20];
    int n, i;
    int keys[3] = {60, 88, 70};
    int k, cb, cn;
    int pb;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (k = 0; k < 3; k++) {
        pb = find_break(a, n, keys[k], &cb);
        cn = 0;
        find_nobreak(a, n, keys[k], &cn);
        if (pb == -1) {
            printf("key = %d : 未找到（pos = -1），比较次数 带break = %d，不带break = %d\n",
                   keys[k], cb, cn);
        } else {
            printf("key = %d : 第 %d 位（pos = %d），比较次数 带break = %d，不带break = %d\n",
                   keys[k], pb + 1, pb, cb, cn);
        }
    }

    return 0;
}
