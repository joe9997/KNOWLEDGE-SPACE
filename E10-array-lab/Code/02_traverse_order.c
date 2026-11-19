#include <stdio.h>

int main(void)
{
    int a[] = {60, 75, 88, 92, 95, 71, 83};
    int n = 7;
    int i;

    printf("下标与分数一一对应：\n");
    for (i = 0; i < n; i++) {
        printf("a[%d] = %d\n", i, a[i]);
    }

    printf("逆序打印：");
    for (i = n - 1; i >= 0; i--) {
        printf("%d ", a[i]);
    }
    printf("\n");

    return 0;
}
