#include <stdio.h>

/* 写法一：found 标记法，循环一定走到 i = n - 1 */
int find_flag(int a[], int n, int key)
{
    int i;
    int pos = -1;
    int found = 0;

    for (i = 0; i < n; i++) {
        if (!found && a[i] == key) {
            pos = i;
            found = 1;
        }
    }
    return pos;
}

/* 写法二：i < n 直接法，找到就 return */
int find_direct(int a[], int n, int key)
{
    int i;

    for (i = 0; i < n; i++) {
        if (a[i] == key) {
            return i;
        }
    }
    return -1;
}

int main(void)
{
    int a[20];
    int n, i;
    int keys[2] = {88, 70};
    int k;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (k = 0; k < 2; k++) {
        printf("key = %d : 写法一 pos = %d，写法二 pos = %d\n",
               keys[k], find_flag(a, n, keys[k]), find_direct(a, n, keys[k]));
    }

    return 0;
}
