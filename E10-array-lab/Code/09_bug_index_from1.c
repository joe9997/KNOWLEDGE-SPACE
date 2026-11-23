#include <stdio.h>

int main(void)
{
    int a[5];
    int n = 5;
    int i;
    int sum = 0;

    for (i = 1; i <= n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        sum += a[i];
    }

    printf("总分 = %d\n", sum);
    printf("平均 = %.2f\n", (double)sum / n);

    return 0;
}
